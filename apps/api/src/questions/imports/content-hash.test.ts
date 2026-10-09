import { describe, expect, it } from "vitest";
import { contentHash, sha256 } from "./domain";

const content = () => ({
  stem: "Não modificar 2 kg, 2² ou unidade µg.",
  alternatives: [
    { key: "A", text: "Primeiro." },
    { key: "B", text: "Segundo!" },
  ],
  correctKey: "A",
  explanation: "Conteúdo exato.",
  areaId: null,
  topicId: null,
  annulled: false,
});
const asset = () => ({
  id: "image",
  objectKey: "private/original.png",
  alt: "Formas originais",
  provenance: { documentId: "document", page: 1, bbox: [0, 0, 1, 1] },
});

describe("CCR119 immutable content hash", () => {
  it("preserves legacy no-assets hashes and top-level payload order", () => {
    const input = content();
    expect(contentHash(input)).toBe(
      sha256(JSON.stringify({ ...input, assets: [] })),
    );
  });
  it("canonicalizes nested object keys without mutating input or array order", () => {
    const input = { ...content(), assets: [asset()] },
      before = JSON.stringify(input);
    const reordered = {
      ...input,
      alternatives: input.alternatives.map((a) => ({
        text: a.text,
        key: a.key,
      })),
      assets: [
        {
          provenance: { bbox: [0, 0, 1, 1], page: 1, documentId: "document" },
          alt: "Formas originais",
          objectKey: "private/original.png",
          id: "image",
        },
      ],
    };
    expect(contentHash(reordered)).toBe(contentHash(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(
      contentHash({
        ...input,
        alternatives: [...input.alternatives].reverse(),
      }),
    ).not.toBe(contentHash(input));
    const two = { ...input, assets: [asset(), { ...asset(), id: "second" }] };
    expect(contentHash({ ...two, assets: [...two.assets].reverse() })).not.toBe(
      contentHash(two),
    );
  });
  it("ignores only volatile top-level asset URLs", () => {
    const input = { ...content(), assets: [asset()] };
    expect(
      contentHash({
        ...input,
        assets: [{ ...asset(), url: "https://example.org/signed?v=2" }],
      }),
    ).toBe(contentHash(input));
    expect(
      contentHash({
        ...input,
        assets: [
          {
            ...asset(),
            provenance: { ...asset().provenance, url: "evidence" },
          },
        ],
      }),
    ).not.toBe(contentHash(input));
  });
  it("invalidates every material asset change", () => {
    const input = { ...content(), assets: [asset()] };
    for (const change of [
      { id: "changed" },
      { alt: "Changed" },
      { objectKey: "private/changed.png" },
      { provenance: { ...asset().provenance, page: 2 } },
      { provenance: { ...asset().provenance, bbox: [0, 0, 0.5, 1] } },
    ])
      expect(
        contentHash({ ...input, assets: [{ ...asset(), ...change }] }),
      ).not.toBe(contentHash(input));
  });
  it("does not normalize clinical text, punctuation, whitespace, units or negation", () => {
    const input = content();
    for (const stem of [
      input.stem.replace("Não ", ""),
      input.stem.replace("2 kg", "20 kg"),
      input.stem.replace("2²", "22"),
      input.stem.replace("µg", "mg"),
      input.stem + " ",
      input.stem.replace(",", ";"),
    ])
      expect(contentHash({ ...input, stem })).not.toBe(contentHash(input));
    expect(
      contentHash({
        ...input,
        alternatives: [
          { ...input.alternatives[0]!, text: "Primeiro!" },
          input.alternatives[1]!,
        ],
      }),
    ).not.toBe(contentHash(input));
  });
  it("keeps incompatible legacy asset signatures distinct instead of silently rehashing them", () => {
    const input = { ...content(), assets: [asset()] },
      legacy = sha256(JSON.stringify(input));
    expect(contentHash(input)).not.toBe(legacy);
    expect(sha256(JSON.stringify(input))).toBe(legacy);
  });
});
