// Compatibility entry point with the original matching/renaming defaults.
import { main } from "./cue_audio.ts";

if (Deno.args.length === 0) {
  console.log(
    "Usage: deno run -A matchAndTag.ts DIRECTORY [--cue file.cue] [options]",
  );
} else {
  Deno.exit(main(["--mode", "match", "--rename", ...Deno.args]));
}
