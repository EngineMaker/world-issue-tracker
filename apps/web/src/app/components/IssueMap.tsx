"use client";

import {
	DEFAULT_LOCALE,
	getUiMessages,
	type Locale,
} from "@world-issue-tracker/shared";
// MapLibre が地図の上に置く部品（帰属表示・拡大縮小ボタン）の見た目。
// これが無いと帰属表示が地図に重なって読めなくなる。
// **CSS だけは静的に読む** — 動的 import の中に置くと、地図が出るまで
// 部品の位置が定まらず、読み込みのたびに画面がずれる
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { buildDetailMapOptions } from "../../lib/map-options";
import { createMap, type MapHandle } from "../../lib/maplibre";

/**
 * Issue 1 件の位置を地図で示す。
 *
 * **MapLibre GL JS で描いている理由（#118）。** #63 ではラスタタイルを
 * `<img>` で並べていた。依存ゼロで絵が出る方式だったが、#115 で本番の
 * 配信元を選ぼうとした結果、**ラスタタイルのまま使える選択肢が無かった**
 * （OSM 公式はポリシーが独自 User-Agent を要求するがブラウザの `<img>` には
 * 設定できず、無料枠のある商用サービスはいずれも商用利用不可）。残ったのが
 * Protomaps を自前配信する道で、これはベクタタイルである。ベクタを描くには
 * ライブラリが要るので、#118 で MapLibre へ移した。
 *
 * **`use client` が付いた理由。** #63 の時点でこの部品は状態もイベントも
 * 持たず、Server Component のまま JS を 1 バイトも配っていなかった。
 * MapLibre は WebGL で描くのでブラウザでの実行が必須になり、その性質は
 * 失われる。**ただし詳細ページ全体は Server Component のまま**で、
 * Client 化はこの部品の中に閉じている（#118 の受け入れ条件）。
 * ページが直接 MapLibre を import すると境界がページまで上がるので、
 * 取り込み口をここ 1 箇所に留めている。
 *
 * **地図が出る前に何も見えなくならないようにしている。** 初期 HTML の
 * 時点では地図の箱と帰属表示だけが出る（`useEffect` はサーバーでは
 * 走らない）。座標の数値は呼び出し側の dl に残っているので、JS が
 * 無効でも、WebGL が使えない環境でも、位置情報そのものは読める。
 */

export function IssueMap({
	latitude,
	longitude,
	title,
	tileUrlTemplate,
	attribution,
	locale = DEFAULT_LOCALE,
}: {
	latitude: number;
	longitude: number;
	/** 地図が何の場所を指しているかをスクリーンリーダーに伝えるために使う。 */
	title: string;
	/** タイル配信元。未設定（null）なら地図を描かない。 */
	tileUrlTemplate: string | null;
	/** 配信元が要求する帰属表示。無ければ null。 */
	attribution: string | null;
	/** 読み上げ用ラベルの言語。地図そのものは言語に依らない */
	locale?: Locale;
}) {
	const container = useRef<HTMLDivElement>(null);
	const map = useRef<MapHandle | null>(null);

	// 地図の設定は `lib/map-options.ts` が組み立てる。MapLibre は WebGL を
	// 要求してテストでは描けないので、**判断を含む部分を描画の外へ出して**
	// 値として検査できる形にしている（`map-options.test.ts`）。
	//
	// null なら地図を出さない。配信元が未設定・判別できない場合で、
	// Issue 63 から続く判断（適当な既定値を焼き込むと、設定を忘れたまま
	// 本番へ出たときに規約違反のトラフィックを出し続ける）。呼び出し側が
	// 座標の数値を表示し続けているので、位置情報そのものは失われない
	const options = buildDetailMapOptions(
		{ latitude, longitude },
		tileUrlTemplate,
		attribution,
	);

	useEffect(() => {
		const element = container.current;
		if (!element) return;

		// 描画の中で組み立て直す。上の `options` をそのまま使うと、
		// 毎回新しいオブジェクトになるので依存配列が毎描画で変わり、
		// 地図が作り直され続ける
		const created = buildDetailMapOptions(
			{ latitude, longitude },
			tileUrlTemplate,
			attribution,
		);
		if (!created) return;

		// 生成は動的 import を挟む（`lib/maplibre.ts` 参照）。完了より先に
		// この部品が消えることがあるので、その場合は即座に捨てる
		let disposed = false;
		createMap({
			...created,
			container: element,
			// 詳細ページは 1 件を指すだけ。マーカーに行き先は要らない
			// （既にその Issue のページにいる）ので、既定のピンを置く
			marker: { longitude, latitude },
		}).then((handle) => {
			if (disposed) {
				handle?.remove();
				return;
			}
			map.current = handle;
		});

		return () => {
			disposed = true;
			map.current?.remove();
			map.current = null;
		};
	}, [tileUrlTemplate, attribution, latitude, longitude]);

	if (!options) {
		return null;
	}

	return (
		<figure className="issue-map">
			{/*
			  地図全体を 1 つの画像として扱う。中で描かれるのは WebGL の
			  キャンバスで、読み上げに使える内容を持たない。座標の数値は
			  呼び出し側（詳細ページの dl）に残っているので、地図が見えない
			  読み手でも位置は読める
			*/}
			<div
				className="issue-map-view"
				ref={container}
				role="img"
				aria-label={getUiMessages(locale).map.label(title, latitude, longitude)}
			/>

			{attribution ? (
				/*
				  帰属表示は隠さないことがタイル配信元の利用条件に含まれる。
				  MapLibre 自身も地図の隅に出すが、地図が読み込めなかったときに
				  消えてしまうので、こちらでも地図の直下に置く。

				  **HTML として描く理由。** 配信元が要求する文言はリンクを含む
				  （#115 が設定した値も `<a href="...">OpenStreetMap</a>`）。
				  素の文字列として出すとタグが画面に見えてしまい、利用条件が
				  求めるリンクにもならない。値の出所は環境変数
				  `NEXT_PUBLIC_MAP_TILE_ATTRIBUTION` で、利用者の入力は混ざらない
				*/
				<figcaption
					className="issue-map-attribution"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: 配信元の帰属表示は環境変数由来で、利用者の入力を含まない
					dangerouslySetInnerHTML={{ __html: attribution }}
				/>
			) : null}
		</figure>
	);
}
