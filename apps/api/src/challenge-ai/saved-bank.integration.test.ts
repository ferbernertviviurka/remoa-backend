import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { err } from "@remoa/contracts";
import type { Env } from "../app";
import {
  challengeAiRoutes,
  createChallengeAiService,
  dbIo,
} from "../routes/challenge-ai";
vi.mock("../cache", () => ({ invalidate: vi.fn(async () => {}) }));
const url = process.env.DATABASE_URL;
if (url) {
  const p = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(p.hostname) ||
    p.pathname !== "/remoa_f33_test_20261008"
  )
    throw Error("Requires exact isolated local F33 test database");
}
describe.skipIf(!url)(
  "CCR123 saved private discursive question SQL adapter",
  () => {
    const owner = randomUUID(),
      foreign = randomUUID(),
      board = randomUUID(),
      otherBoard = randomUUID(),
      question = randomUUID(),
      otherQuestion = randomUUID(),
      noReference = randomUUID(),
      objective = randomUUID();
    const stem =
      "Texto autoral de engenharia. ".repeat(200) + "Não substituir 2 kg.";
    let db: typeof import("@remoa/db");
    const io = dbIo();
    io.generate = vi.fn(async () => err("internal", "must_not_generate"));
    io.grade = vi.fn(async () => {
      throw Error("must_not_grade_on_start");
    });
    const service = createChallengeAiService(io);
    function appFor(user: string) {
      const app = new Hono<Env>();
      app.use("*", async (c, next) => {
        c.set("userId", user);
        c.set("requestId", randomUUID());
        c.set("log", {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        } as Env["Variables"]["log"]);
        await next();
      });
      app.route("/v1/challenge-ai", challengeAiRoutes(service));
      return app;
    }
    const request = (user: string, id: string) =>
      appFor(user).request(`/v1/challenge-ai/bank/${id}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    beforeAll(async () => {
      db = await import("@remoa/db");
      await db.db
        .$client`INSERT INTO auth.users(id,email) VALUES(${owner},${owner + "@f33.example"}),(${foreign},${foreign + "@f33.example"})`;
      await db.db
        .$client`INSERT INTO boards(id,user_id,title) VALUES(${board},${owner},'Synthetic saved bank'),(${otherBoard},${foreign},'Other private owner')`;
      for (const [id, user, b, type, answer, points] of [
        [
          question,
          owner,
          board,
          "discursive",
          "Expected private answer",
          ["gatilho"],
        ],
        [
          otherQuestion,
          foreign,
          otherBoard,
          "discursive",
          "Foreign answer",
          ["gatilho"],
        ],
        [noReference, owner, board, "discursive", "", []],
        [objective, owner, board, "objective", "A", []],
      ] as const) {
        const alternatives =
          type === "objective"
            ? JSON.stringify([
                { key: "A", text: "First" },
                { key: "B", text: "Second" },
              ])
            : null;
        await db.db
          .$client`INSERT INTO question_bank(id,user_id,board_id,type,difficulty,stem,expected_answer,key_points,source,alternatives,correct_key) VALUES(${id},${user},${b},${type},'medium',${stem},${answer},${[...points]},'ai',${alternatives}::jsonb,${type === "objective" ? "A" : null})`;
      }
    });
    afterAll(async () => {
      if (!db) return;
      await db.db
        .$client`DELETE FROM auth.users WHERE id IN(${owner},${foreign})`;
      await db.db.$client.end({ timeout: 1 });
    });
    it("serializes simultaneous starts, freezes exactly one bank item and preserves the entire stem without provider calls", async () => {
      const responses = await Promise.all([
        request(owner, question),
        request(owner, question),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      const [a, b] = await Promise.all(responses.map((r) => r.json()));
      expect(a.data.session.id).toBe(b.data.session.id);
      expect(a.data.session.current.stem).toBe(stem);
      const rows = await db.db
        .$client`SELECT i.bank_id,i.card_id,i.reference_ref,i.payload_public FROM challenge_items i JOIN challenge_sessions s ON s.id=i.session_id WHERE s.user_id=${owner}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        bank_id: question,
        card_id: null,
        reference_ref: { kind: "bank", bankId: question },
      });
      expect(JSON.stringify(a)).not.toContain("Expected private answer");
      expect(io.generate).not.toHaveBeenCalled();
      expect(io.grade).not.toHaveBeenCalled();
    });
    it("refuses another owner and objective/no-reference questions without creating additional sessions", async () => {
      expect((await request(owner, otherQuestion)).status).toBe(404);
      expect((await request(foreign, question)).status).toBe(404);
      expect((await request(owner, objective)).status).toBe(404);
      expect((await request(owner, noReference)).status).toBe(409);
      expect(io.generate).not.toHaveBeenCalled();
    });
    it("does not reopen even an existing saved session after the map becomes unavailable", async () => {
      await db.db
        .$client`UPDATE boards SET archived_at=now() WHERE id=${board}`;
      expect((await request(owner, question)).status).toBe(404);
      expect(io.generate).not.toHaveBeenCalled();
      await db.db.$client`UPDATE boards SET archived_at=NULL WHERE id=${board}`;
    });
    it("refuses withdrawn/rejected private questions even when an active session exists", async () => {
      const before = await db.db
        .$client`SELECT count(*)::int AS count FROM challenge_sessions WHERE user_id=${owner}`;
      for (const status of ["withdrawn", "rejected"]) {
        await db.db
          .$client`UPDATE question_bank SET catalog_status=${status} WHERE id=${question}`;
        expect((await request(owner, question)).status).toBe(404);
      }
      await db.db
        .$client`UPDATE question_bank SET catalog_status='draft' WHERE id=${question}`;
      const after = await db.db
        .$client`SELECT count(*)::int AS count FROM challenge_sessions WHERE user_id=${owner}`;
      expect(after[0]!.count).toBe(before[0]!.count);
      expect(io.generate).not.toHaveBeenCalled();
      expect(io.grade).not.toHaveBeenCalled();
    });
    it("applies catalog rollout before looking up the saved question", async () => {
      const spy = vi.spyOn(service, "startSaved");
      vi.stubEnv("QUESTIONS_CATALOG_ENABLED", "0");
      try {
        expect((await request(owner, question)).status).toBe(404);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
        spy.mockRestore();
      }
    });
  },
);
