/**
 * 地図タイルの座標計算と、タイル配信元の設定。
 *
 * 起票フォームは緯度経度を必須にしているのに、その座標を地図で見せる画面が
 * 無かった（#63）。1 件の位置を示すだけなので、地図ライブラリを足さず
 * ラスタタイルの画像を並べて実現している。選定の経緯は `IssueMap.tsx` に書いた。
 *
 * ここは描画に関わらない純粋な計算だけを置く。座標変換を間違えると
 * 「地図は出るが指している場所が違う」という、見た目では気付きにくい
 * 壊れ方をするため、独立してテストできる形にしている。
 */

/** 1 枚のタイル画像の一辺（px）。標準的なラスタタイルの大きさ。 */
export const TILE_SIZE = 256;

/**
 * 表示するズームレベル。
 *
 * 15 は「その建物の前の通りが分かる」程度の縮尺で、街灯やごみ集積所のような
 * 近隣スコープの困りごとを指すのに合う。国や世界スコープの Issue でも
 * 「点がどこか」は分かるので、まずは 1 段階に固定する
 * （スコープ別ズームは範囲外 — Issue のコメント参照）。
 */
export const MAP_ZOOM = 15;

/**
 * 経度をタイル座標 X に変換する。
 *
 * 戻り値は整数ではなく小数で、整数部がタイル番号、小数部がそのタイル内での
 * 位置（0〜1）を表す。マーカーをタイルの中のどこに置くかに小数部が要る。
 */
export function longitudeToTileX(longitude: number, zoom: number): number {
	return ((longitude + 180) / 360) * 2 ** zoom;
}

/**
 * Web Mercator が表現できる緯度の限界（度）。
 *
 * この図法は極に近づくほど縦に引き伸ばされ、±90 度では無限に発散する。
 * 世界が正方形に収まるよう、地図タイルは南北をここで打ち切るのが慣例。
 */
const MAX_MERCATOR_LATITUDE = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI;

/**
 * 緯度をタイル座標 Y に変換する。
 *
 * 経度と違い線形ではない（Web Mercator 図法）。高緯度ほど引き伸ばされるため、
 * 線形に計算すると赤道から離れるほどずれが大きくなる。
 *
 * 緯度は図法の限界へ丸めてから計算する。`CreateIssueSchema` は -90〜90 を
 * そのまま許すので極点の Issue は実際に起票できるが、丸めずに計算すると
 * `Math.tan(±90°)` が発散して `Infinity` になり、タイル URL に "Infinity" が
 * 埋まった壊れたリクエストを投げる。丸めた場合に生じる誤差は図法の限界より
 * 高緯度でだけで、そこは元々タイルが存在しない領域である。
 */
export function latitudeToTileY(latitude: number, zoom: number): number {
	const clamped = Math.min(
		MAX_MERCATOR_LATITUDE,
		Math.max(-MAX_MERCATOR_LATITUDE, latitude),
	);
	const radians = (clamped * Math.PI) / 180;
	const mercator =
		Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI;
	const y = ((1 - mercator) / 2) * 2 ** zoom;

	// 限界緯度そのものを渡すと、浮動小数点の丸めで 0 や 2^zoom を
	// ごくわずかに超えることがある（-2e-7 など）。呼び出し側が
	// `Math.floor` した結果が -1 になり、存在しないタイルを指してしまうため、
	// ここで範囲に収める
	return Math.min(2 ** zoom, Math.max(0, y));
}

/** `{s}` を含むテンプレート用のサブドメイン候補。慣例的な a/b/c を使う。 */
const SUBDOMAINS = ["a", "b", "c"] as const;

/**
 * タイル URL のテンプレートを実際の URL に変換する。
 *
 * `{z}/{x}/{y}` は事実上の標準で、多くの配信元がこの形を取る。
 * `{s}`（サブドメイン）を使う配信元もあるため、含まれていればタイル座標から
 * 決める。乱数を使わないのは、同じタイルが常に同じ URL になった方が
 * ブラウザのキャッシュに乗るため。
 */
export function tileUrl(
	template: string,
	x: number,
	y: number,
	zoom: number,
): string {
	// 剰余なので必ず範囲内に収まるが、`noUncheckedIndexedAccess` の下では
	// 添字アクセスが `undefined` を含む型になる。既定値で受けて型を閉じる
	const subdomain =
		SUBDOMAINS[Math.abs(x + y) % SUBDOMAINS.length] ?? SUBDOMAINS[0];

	return template
		.replace("{s}", subdomain)
		.replace("{z}", String(zoom))
		.replace("{x}", String(x))
		.replace("{y}", String(y));
}

/**
 * タイル配信元のテンプレート URL。未設定なら null。
 *
 * 既定値を持たせていない理由。地図ライブラリの例で使われる OpenStreetMap の
 * 公開タイルサーバー（tile.openstreetmap.org）は、利用規約で本番アプリからの
 * 直接利用が制限されている（https://operations.osmfoundation.org/policies/tiles/）。
 * 既定値として焼き込むと、設定を忘れたまま本番に出たときに規約違反の
 * トラフィックを出し続ける。それは「地図が出ない」より悪い。
 *
 * そのため未設定時は地図を出さず、座標の数値だけを見せる形にしている。
 * 開発中の動作確認は `.env.local` に配信元を書いて行う（`.env.local.example` 参照）。
 *
 * `NEXT_PUBLIC_` 接頭辞の値はビルド時に静的置換されるので、
 * `process.env` の参照を変数に切り出さず直接書く必要がある（`lib/api.ts` と同じ）。
 */
export function resolveTileUrlTemplate(): string | null {
	const template = process.env.NEXT_PUBLIC_MAP_TILE_URL?.trim();
	return template ? template : null;
}

/**
 * 地図に添える帰属表示。未設定なら null。
 *
 * OSM 系のタイルは帰属表示が利用条件に含まれる。配信元ごとに要求される
 * 文言が違うので、配信元 URL と対で設定する。
 */
export function resolveTileAttribution(): string | null {
	const attribution = process.env.NEXT_PUBLIC_MAP_TILE_ATTRIBUTION?.trim();
	return attribution ? attribution : null;
}
