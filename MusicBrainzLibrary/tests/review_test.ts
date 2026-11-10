import { compileReview, type ReviewRecord, reviewText } from "../src/review.ts";
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
const record = (
  status: string,
  extra: Partial<ReviewRecord> = {},
): ReviewRecord => ({
  release: "11111111-1111-4111-8111-111111111111",
  title: "Album",
  status,
  ...extra,
});
Deno.test("no-candidate and failed checks appear once in the manual list", () => {
  const states = [
    "no-digital-candidate",
    "no-verified-new-links",
    "provider-check-failed",
    "needs-verified-album",
  ];
  const list = compileReview(
    states.map((status, index) =>
      record(status, { release: `release-${index}` })
    ),
  );
  equal(list.length, 4);
  equal(list.filter((item) => item.type === "release").length, 4);
  if (
    !list.find((item) => item.id === "release-0")?.reasons.some((reason) =>
      reason.includes("No digital candidate")
    )
  ) throw Error("Missing actionable no-candidate reason");
});
Deno.test("successful, ready and actively processing releases do not inflate review counts", () => {
  for (
    const status of [
      "verified",
      "planned",
      "existing-digital-edition",
      "digital-edition-created",
      "digital-edition-planned",
      "probing",
      "submitting",
      "seeding-digital-edition",
      "creating-digital-edition",
    ]
  ) {
    const extra = status === "probing"
      ? { mapping: { rejected: [{ reason: "Old conflict" }] } }
      : {};
    equal(compileReview([record(status, extra)]), []);
  }
});
Deno.test("partial successes expose affected recording links and prefer the latest mapping", () => {
  const rejected = {
    recording: "22222222-2222-4222-8222-222222222222",
    reason: "Conflicting ISRC",
  };
  const state = record("verified", {
    mapping: {
      rejected: [{
        recording: rejected.recording,
        reason: "Old artist conflict",
      }],
    },
    currentMapping: { rejected: [rejected] },
    releaseData: {
      media: [{
        tracks: [{ title: "曲", recording: { id: rejected.recording } }],
      }],
    },
  });
  const list = compileReview([state]);
  equal(list.length, 1);
  equal(list[0].recordings[0].title, "曲");
  equal(
    list[0].recordings[0].url,
    `https://musicbrainz.org/recording/${rejected.recording}`,
  );
  equal(list[0].reasons.includes("Old artist conflict"), false);
  state.currentMapping = { rejected: [] };
  equal(compileReview([state]), []);
});
Deno.test("source uncertainty and native editor problems cannot be hidden by a success status", () => {
  const source = compileReview([
    record("verified", {
      releaseSources: { status: "uncertain", error: "Lost response" },
    }),
  ]);
  equal(source.length, 1);
  equal(source[0].reasons.includes("Lost response"), true);
  const edition = compileReview([
    record("digital-edition-review", {
      edition: {
        status: "digital-edition-review",
        problems: ["Missing label"],
        plan: { unresolved: ["Artist unresolved"], reasons: ["Wrong edition"] },
      },
    }),
  ]);
  for (
    const reason of ["Missing label", "Artist unresolved", "Wrong edition"]
  ) equal(edition[0].reasons.includes(reason), true);
});
Deno.test("orphan recordings and failed lookups are included, named and deduplicated", () => {
  const list = compileReview([], {
    withoutRelease: ["one", "one"],
    auditFailures: [
      { id: "one", title: "Named recording", error: "HTTP 503" },
      { id: "two", error: "HTTP 404" },
    ],
  }, [{ id: "two", title: "Second recording" }]);
  equal(list.length, 2);
  equal(list[0].title, "Named recording");
  equal(list[0].reasons.length, 2);
  equal(list[1].title, "Second recording");
  equal(list[0].type, "recording");
});
Deno.test("unknown terminal outcomes remain visible with a reason", () => {
  const [item] = compileReview([record("future-review-status")]);
  equal(item.reasons.length, 1);
  equal(
    item.url,
    "https://musicbrainz.org/release/11111111-1111-4111-8111-111111111111",
  );
});
Deno.test("downloaded report uses exactly the compiled list and includes detailed reasons", () => {
  const list = compileReview([
    record("no-digital-candidate"),
    record("verified", { release: "clean", title: "Clean success" }),
  ], { withoutRelease: ["orphan"] });
  const text = reviewText(list);
  for (
    const value of [
      "1 releases; 1 recordings",
      "No digital candidate",
      "https://musicbrainz.org/recording/orphan",
    ]
  ) if (!text.includes(value)) throw Error("Incomplete report");
  equal(text.includes("Clean success"), false);
});
