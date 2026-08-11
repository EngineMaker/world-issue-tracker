import { ISSUE_PHOTO_MAX_BYTES } from "@world-issue-tracker/shared";

/**
 * 送る前に縮小する写真の長辺（px）。
 *
 * 縮小は負荷対策ではなく、利用者の失敗を防ぐためのもの（#65）。最近の
 * スマホの写真は 1 枚 3〜8MB あり、そのままだと 5MB の上限に引っかかる
 * 写真が珍しくない。「写真を選んだのにエラーで弾かれる」のは、負担を
 * 減らすという方針と正面から衝突する。
 *
 * 1600px は、地図やカードに載せる用途で細部が潰れず、JPEG に変換すれば
 * 概ね 1MB 未満に収まる大きさ。
 */
export const PHOTO_MAX_EDGE = 1600;

/**
 * 縮小後に使う JPEG の品質。
 *
 * 0.85 は、街灯や雑草といった被写体で圧縮の痕が目に付かず、かつ
 * ファイルサイズが素直に落ちる範囲。上げるほど 5MB に近づくため、
 * 「弾かれない」ことを優先してここに置いている。
 */
export const PHOTO_JPEG_QUALITY = 0.85;

/** 縮小して送るときのファイル名。拡張子は変換後の形式に合わせる。 */
const RESIZED_FILE_NAME = "photo.jpg";

/**
 * 縮小の結果。
 *
 * 失敗を例外ではなく値で返すのは、呼び出し側（フォーム）が
 * 「縮小できなかった」と「大きすぎる」を別の文言で出し分けるため。
 */
export type ResizeResult =
	| { ok: true; file: File }
	| { ok: false; reason: "too-large" | "unsupported" };

/**
 * 元の寸法から、長辺を `maxEdge` に収めた寸法を求める。
 *
 * 既に収まっているなら拡大はしない（引き伸ばしても情報は増えず、
 * ファイルサイズだけが増える）。
 *
 * 計算結果は必ず 1px 以上にする。極端に細長い画像で短辺が 0 に
 * 丸まると、`canvas` の生成そのものが失敗するため。
 */
export function fitWithin(
	width: number,
	height: number,
	maxEdge: number = PHOTO_MAX_EDGE,
): { width: number; height: number } {
	const longest = Math.max(width, height);
	if (longest <= maxEdge) {
		return { width, height };
	}
	const scale = maxEdge / longest;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/**
 * 選ばれた画像を、長辺 `PHOTO_MAX_EDGE` の JPEG に縮小する。
 *
 * ブラウザ専用（`createImageBitmap` と `canvas` を使う）。サーバー側の
 * 上限チェックはこれとは別に必ず行う（`apps/api` の `validatePhoto`）。
 * ここでの縮小は迂回できるので、防御にはならない。
 *
 * 縮小しても上限を超える場合だけ `too-large` を返す。デコードできない
 * ファイル（画像でないもの、壊れたもの）は `unsupported`。
 *
 * 縮小後の方が大きくなることがある（元が高圧縮の小さな JPEG で、
 * 寸法が既に上限内のとき）。その場合は元のファイルをそのまま使う。
 * 送るバイト数を増やすためだけに変換する意味が無い。
 */
export async function resizeImageFile(file: File): Promise<ResizeResult> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		// 画像として読めないもの。`accept` 属性はすり抜けられるので、
		// ここに来ることは実際にある
		return { ok: false, reason: "unsupported" };
	}

	try {
		const { width, height } = fitWithin(bitmap.width, bitmap.height);

		// 寸法が既に収まっていて、かつサイズも上限内なら変換しない。
		// 再エンコードは画質を落とすだけで、得るものが無い
		if (
			width === bitmap.width &&
			height === bitmap.height &&
			file.size <= ISSUE_PHOTO_MAX_BYTES
		) {
			return { ok: true, file };
		}

		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) {
			return { ok: false, reason: "unsupported" };
		}
		context.drawImage(bitmap, 0, 0, width, height);

		const blob = await new Promise<Blob | null>((resolve) => {
			canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY);
		});
		if (!blob) {
			return { ok: false, reason: "unsupported" };
		}

		// 縮小しても上限を超えるなら、そこで初めて利用者にエラーを見せる
		if (blob.size > ISSUE_PHOTO_MAX_BYTES) {
			return { ok: false, reason: "too-large" };
		}

		// 変換した結果が元より大きいなら元を使う（元も上限内のときだけ）
		if (blob.size >= file.size && file.size <= ISSUE_PHOTO_MAX_BYTES) {
			return { ok: true, file };
		}

		return {
			ok: true,
			file: new File([blob], RESIZED_FILE_NAME, { type: "image/jpeg" }),
		};
	} finally {
		// デコード済みのビットマップは明示的に解放する。
		// 大きな写真を続けて選ぶとメモリを掴んだままになる
		bitmap.close();
	}
}
