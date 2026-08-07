import {
	latitudeToTileY,
	longitudeToTileX,
	MAP_ZOOM,
	TILE_SIZE,
	tileUrl,
} from "../../lib/map";

/**
 * Issue 1 件の位置を地図で示す。
 *
 * 地図ライブラリを使っていない理由。この画面で必要なのは「1 件がどこか」を
 * 示すことだけで、パン・ズーム・複数地点の描画は要らない（一覧の地図表示や
 * ヒートマップは #63 の範囲外）。Leaflet を入れると 40KB 強の JS と CSS を
 * 全利用者に配ることになるが、得られるのは今は使わない対話機能である。
 * ラスタタイルを `<img>` で並べれば、追加の依存ゼロ・JS ゼロで同じ絵が出る。
 *
 * この選択は将来を塞がない。一覧の地図表示を作る段階で、そのとき必要な
 * 対話機能を見てからライブラリを選べばよく、そのときこの部品を差し替えるだけで済む。
 *
 * Server Component のままでも描けるが、詳細ページ全体を Client 化しないために
 * 部品として切り出している（Issue のコメントの指示）。実際 `use client` は
 * 付けていない — 状態もイベントハンドラも持たないため、JS を配る必要がない。
 *
 * タイルは中心の 1 枚だけだと Issue の地点が端に寄ったときに周囲が切れるので、
 * 3x3 で並べて中心を画面の中央に置く。
 *
 * タイルに `next/image` ではなく `<img>` を使っている理由（lint を抑制している）。
 * 地図タイルは配信元が既に 256x256 に最適化して配っている画像で、変換しても
 * 得るものが無い（Workers では OpenNext 経由の変換コストが増えるだけ）。
 * さらに `next/image` は外部ドメインを `next.config.ts` の `remotePatterns` に
 * 列挙する必要があり、配信元を環境変数で差し替える設計と噛み合わない。
 */

/** 中心タイルの周囲に何枚ずつ並べるか。1 なら 3x3。 */
const TILE_RADIUS = 1;

/** 地図の表示サイズ（px）。3x3 のタイルから、はみ出す分を切り落として使う。 */
const VIEW_SIZE = TILE_SIZE * 2;

/** このズームで世界を覆うタイルの枚数（一辺）。番号はこの範囲にしか存在しない。 */
const WORLD_TILES = 2 ** MAP_ZOOM;

export function IssueMap({
	latitude,
	longitude,
	title,
	tileUrlTemplate,
	attribution,
}: {
	latitude: number;
	longitude: number;
	/** 地図が何の場所を指しているかをスクリーンリーダーに伝えるために使う。 */
	title: string;
	/** タイル配信元。未設定（null）なら地図を描かない。 */
	tileUrlTemplate: string | null;
	/** 配信元が要求する帰属表示。無ければ null。 */
	attribution: string | null;
}) {
	// 配信元が決まっていないときは何も描かない。
	// 適当な既定値でタイルを取りに行くと、規約違反のトラフィックを出すか、
	// 読み込めない画像を並べることになる。呼び出し側が座標の数値を
	// 表示し続けているので、位置情報そのものは失われない
	if (!tileUrlTemplate) {
		return null;
	}

	// 中心タイルの座標。整数部がタイル番号、小数部がタイル内の位置
	const centerX = longitudeToTileX(longitude, MAP_ZOOM);
	const centerY = latitudeToTileY(latitude, MAP_ZOOM);
	const centerTileX = Math.floor(centerX);
	const centerTileY = Math.floor(centerY);

	// 3x3 のタイル群の左上を基準に、Issue の地点が表示領域の中央へ来るよう
	// タイル全体をずらす量（px）
	const offsetX =
		VIEW_SIZE / 2 - (centerX - centerTileX + TILE_RADIUS) * TILE_SIZE;
	const offsetY =
		VIEW_SIZE / 2 - (centerY - centerTileY + TILE_RADIUS) * TILE_SIZE;

	const offsets = Array.from(
		{ length: TILE_RADIUS * 2 + 1 },
		(_, index) => index - TILE_RADIUS,
	);

	return (
		<figure className="issue-map">
			{/*
			  タイル 1 枚ごとの alt は空にしている。地図を構成する画像片には
			  個別の意味が無く、読み上げても雑音にしかならない。
			  代わりに地図全体へ role/aria-label を与えて 1 つの画像として扱う。
			  座標の数値は呼び出し側（詳細ページの dl）に残っているので、
			  地図が見えない読み手でも位置は読める
			*/}
			<div
				className="issue-map-view"
				role="img"
				aria-label={`${title} の位置。緯度 ${latitude} / 経度 ${longitude}`}
				style={{ width: VIEW_SIZE, height: VIEW_SIZE }}
			>
				<div
					className="issue-map-tiles"
					style={{ transform: `translate(${offsetX}px, ${offsetY}px)` }}
				>
					{offsets.map((dy) => (
						<div className="issue-map-row" key={dy}>
							{offsets.map((dx) => {
								// 世界は東西につながっているので、東端の先は西端に戻る。
								// 日付変更線をまたぐ地点でも地図が途切れない
								const x =
									(((centerTileX + dx) % WORLD_TILES) + WORLD_TILES) %
									WORLD_TILES;
								const y = centerTileY + dy;

								// 南北はつながっていない。地図の上端・下端より外には
								// タイルが存在しないので、要求せず空白のまま置く
								// （存在しない番号を投げると 404 が並び、配信元にも無駄がかかる）
								if (y < 0 || y >= WORLD_TILES) {
									return (
										<div
											key={`blank-${dx}`}
											className="issue-map-blank"
											style={{ width: TILE_SIZE, height: TILE_SIZE }}
										/>
									);
								}

								return (
									// biome-ignore lint/performance/noImgElement: next/image はこの用途に合わない（理由はファイル冒頭）
									<img
										key={`${x},${y}`}
										src={tileUrl(tileUrlTemplate, x, y, MAP_ZOOM)}
										alt=""
										width={TILE_SIZE}
										height={TILE_SIZE}
										// タイルは折りたたみの下に来ることが多く、
										// 遅延読み込みで初期表示の帯域を空けられる
										loading="lazy"
										// 配信元は別オリジン。参照元 URL を渡す必要はない
										referrerPolicy="no-referrer"
										draggable={false}
									/>
								);
							})}
						</div>
					))}
				</div>

				{/*
				  マーカーは表示領域の中央に固定で置く。タイル側を
				  ずらして地点を中央へ持ってきているため、ここは動かさない
				*/}
				<div className="issue-map-marker" aria-hidden="true" />
			</div>

			{attribution ? (
				// 帰属表示は隠さないことが OSM 系タイルの利用条件に含まれる。
				// 地図の直下に、地図と同じ幅で置く
				<figcaption className="issue-map-attribution">{attribution}</figcaption>
			) : null}
		</figure>
	);
}
