# Prompt generations

Every model input packet embeds its full instruction text, and the host verifies a
stored packet by rebuilding it (`PACKET_CHANGED` otherwise). Editing a prompt in
place therefore used to invalidate every packet sealed before the edit: paid
evidence, pending crash-recovery turns and maintenance inputs.

Packets are now accepted if **any known generation** rebuilds them exactly:

- `prompts/` — the current generation, used for all new packets;
- `prompts/archive/<generation>/` — complete, immutable snapshots of earlier
  generations, listed in `src/prompt-generations.mjs` (`ARCHIVED_PROMPT_GENERATIONS`).

The tamper check is unchanged: an instruction that no host generation produces
is still rejected.

## Changing a prompt

1. Copy the whole current `prompts/*.md` set into `prompts/archive/<new-generation>/`
   (only the `.md` files at the top level; not `archive/` itself).
2. Add `<new-generation>` to the front of `ARCHIVED_PROMPT_GENERATIONS`.
3. Edit `prompts/` freely. Do not edit archived files.

If code assembles prompt text with `String.replace`, keep the pattern for each
generation that is still verifiable (a non-matching replace is a no-op).

`r006` is the exact prompt set of commit 987045e (JY-RECOVERY-006), plus the
operation-boundary text that was previously inlined in `src/cognition.mjs`.
