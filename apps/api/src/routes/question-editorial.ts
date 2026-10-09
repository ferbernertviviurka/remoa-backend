import { questionEditorialCatalogRoutes } from '../questions/editorial/routes';
import { Hono } from "hono";
import { err } from "@remoa/contracts";
import type { Env } from "../app";
import { send } from "../admin/core";
import {
  questionReviewDetail,
  questionReviewQueue,
  recordMedicalReview,
} from "../questions/editorial/service";
import { idValid } from "../admin/questions/service";
import { questionEditorialReportRoutes } from "../questions/reports/editorial";
/** Mounted under requireUser by app.ts. Medical decisions require reviewer + name + validated CRM. */
export const questionEditorialRoutes = new Hono<Env>()
  .route("/", questionEditorialCatalogRoutes)
  .route("/reports", questionEditorialReportRoutes)

  .get("/", async (c) => send(await questionReviewQueue(c)))
  .get("/:id", async (c) =>
    send(
      idValid(c.req.param("id"))
        ? await questionReviewDetail(c, c.req.param("id"))
        : err("not_found", "question not found"),
    ),
  )
  .post("/:id/review", async (c) =>
    send(
      idValid(c.req.param("id"))
        ? await recordMedicalReview(
            c,
            c.req.param("id"),
            await c.req.json().catch(() => null),
          )
        : err("not_found", "question not found"),
    ),
  );
