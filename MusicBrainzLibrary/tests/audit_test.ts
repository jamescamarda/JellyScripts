import {
  barcodeKey,
  hasSupportedStream,
  releaseLinkAllowed,
  supportedLiveStreams,
} from "../src/audit.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

Deno.test("strict GTIN matching accepts padding, rejects missing and bad check digits", () => {
  equal(barcodeKey("012345678905"), barcodeKey("0012345678905"));
  equal(barcodeKey("4542519006570"), "04542519006570");
  for (
    const value of [
      null,
      "",
      "[none]",
      "000000000000",
      "4542519006571",
      "abc",
      "123",
    ]
  ) {
    equal(barcodeKey(value), null);
  }
});

Deno.test("matching barcode cannot attach a digital stream to a physical or unknown edition", () => {
  const provider = { barcode: "4542519006570", tracks: 16, digital: true };
  for (const format of ["CD", "DVD", "Vinyl", null, undefined]) {
    equal(
      releaseLinkAllowed({
        barcode: provider.barcode,
        media: [{ format, "track-count": 16 }],
      }, provider),
      false,
    );
  }
  equal(releaseLinkAllowed({ barcode: provider.barcode }, provider), false);
});

Deno.test("digital release still requires verified barcode, format and complete track count", () => {
  const release = {
    barcode: "4542519006570",
    media: [{ format: "Digital Media", "track-count": 16 }],
  };
  const provider = { barcode: release.barcode, tracks: 16, digital: true };
  equal(releaseLinkAllowed(release, provider), true);
  equal(releaseLinkAllowed(release, { ...provider, tracks: 18 }), false);
  equal(releaseLinkAllowed(release, { ...provider, barcode: null }), false);
  equal(releaseLinkAllowed(release, { ...provider, digital: false }), false);
  equal(releaseLinkAllowed({ ...release, media: [] }, provider), false);
  equal(
    releaseLinkAllowed({
      ...release,
      media: [...release.media, { format: "CD", "track-count": 16 }],
    }, { ...provider, tracks: 32 }),
    false,
  );
});

Deno.test("purchase links do not establish Library stream coverage", () => {
  equal(
    hasSupportedStream({
      providerLinks: [{ service: "bandcamp", linkType: "purchase" }],
    }),
    false,
  );
  equal(
    hasSupportedStream({
      providerLinks: [{ service: "spotify", linkType: "audio" }],
    }),
    true,
  );
});

Deno.test("live relationships exclude ended links, album URLs and unsupported providers", () => {
  const relation = (url: string, type = "free streaming", ended = false) => ({
    type,
    ended,
    url: { resource: url },
  });
  equal(
    supportedLiveStreams([
      relation("https://open.spotify.com/track/2km9fP2b21EhdNTzgGABZ3"),
      relation("https://music.youtube.com/watch?v=YNOGk_jnIQU"),
      relation("https://soundcloud.com/artist/recording"),
      relation("https://open.spotify.com/album/3SbMu7Z8xAoZjz0v25BDWp"),
      relation("https://soundcloud.com/artist/sets"),
      relation(
        "https://music.youtube.com/watch?v=YNOGk_jnIQU",
        "free streaming",
        true,
      ),
      relation("https://music.apple.com/jp/song/474734275", "streaming"),
      relation(
        "https://music.youtube.com/watch?v=YNOGk_jnIQU",
        "purchase for download",
      ),
    ]).length,
    3,
  );
});
