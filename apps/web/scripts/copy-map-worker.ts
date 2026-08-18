/**
 * MapLibre のワーカーを `public/` へ複製する（#127）。
 *
 * **なぜ要るか。** MapLibre はワーカーを
 * `new Worker(new URL("./maplibre-gl-worker.mjs", import.meta.url), { type: "module" })`
 * の形で起動する。バンドラはこれをハッシュ付きの単一ファイルとして出力するが、
 * **ワーカーの中にある `import "./maplibre-gl-shared.mjs"` までは解決しない。**
 * その結果ワーカーは起動できず、404 ページ（HTML）を受け取って MIME type の
 * 不一致で失敗する。
 *
 * **失敗しても MapLibre の `error` イベントには乗らない。** ワーカーが無いまま
 * 地図は生成され、タイルを 1 枚も処理できずに描画が一度も走らない。canvas は
 * 完全に空のままで、スタイルの背景レイヤの色すら出ない。本番の地図が真っ白
 * だったのはこれが原因だった。
 *
 * そこでバンドラを通さず、ワーカーと依存を素のまま `public/` に置いて配る。
 * 2 つは同じディレクトリに置く必要がある（ワーカーが相対で import するため）。
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** ワーカー本体と、それが import する依存。順序に意味は無いが両方必須。 */
const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"] as const;

const distDir = dirname(require.resolve("maplibre-gl/dist/maplibre-gl.mjs"));
const outDir = join(import.meta.dirname, "..", "public", "maplibre");

mkdirSync(outDir, { recursive: true });

for (const file of FILES) {
	copyFileSync(join(distDir, file), join(outDir, file));
}

console.log(
	`[map] ワーカーを public/maplibre/ に複製した (${FILES.join(", ")})`,
);
