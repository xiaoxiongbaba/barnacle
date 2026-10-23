# Vendored from Habblaud

The procedural pixel art in `art/` and `world/` (and the few helpers it needs in `shared/`) comes from
[Habblaud](https://github.com/marmottajr/habblaud) by Márcio Junior, under the MIT licence (see
`LICENSE`). Copied from commit faa1a01. Changes for Barnacle:

- import paths adjusted to this folder;
- `shared/i18n.ts` replaced by a stand-in (the art only uses it for editor hints);
- `world/props.ts` (outdoor trees, hedges, lamps, cars) from `client/src/world/render/`, with
  `world/types.ts` holding the one type it needs;
- `ui/icons.ts`: the pixel icons from `client/src/ui/icons.ts`, without Habblaud's logo and wordmark
  (Barnacle has its own brand).

Keep this folder close to upstream so updates can be merged; Barnacle's own glue lives in
`web/src/floor/art-habblaud.ts`.
