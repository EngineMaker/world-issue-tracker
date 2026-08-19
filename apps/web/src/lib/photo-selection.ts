import type { Dispatch, SetStateAction } from "react";
import { createThumbnailFile, resizeImageFile } from "./photo";

/**
 * 選ばれた写真の状態（#65）。
 *
 * 縮小はブラウザ側で行うため、選んでから送れる状態になるまでに間がある。
 * 「選んだのに何も起きない」時間を作らないよう、処理中も状態として持つ。
 */
export type PhotoState =
	| { status: "empty" }
	| { status: "processing" }
	/**
	 * `thumbnail` は一覧のカード用に作る小さい派生物（#125）。
	 * 作れなかったときは null になるが、送信は止めない
	 * （API 側が原寸に倒して配信する）。
	 */
	| {
			status: "ready";
			file: File;
			thumbnail: File | null;
			previewUrl: string;
	  }
	| { status: "failed"; message: string };

/** 縮小に失敗したときの文言。ロケール依存なので取得関数で渡す。 */
export interface PhotoSelectionMessages {
	photoTooLarge: string;
	photoUnreadable: string;
}

/**
 * 写真選択ハンドラの依存。テストのために差し替えられるようにしてある。
 *
 * `resize` / `createThumbnail` は既定でブラウザ実装（`lib/photo.ts`）を使う。
 * これらは `createImageBitmap` と `<canvas>` に依存し、テスト環境には
 * 無いため、競合の検証では差し替える。
 *
 * `createObjectURL` / `revokeObjectURL` も同じ理由で差し替え可能にし、
 * 「敗者側の URL を作らない・作ったら解放する」ことを数えられるようにする。
 */
export interface PhotoSelectionDeps {
	setPhoto: Dispatch<SetStateAction<PhotoState>>;
	getMessages: () => PhotoSelectionMessages;
	resize?: typeof resizeImageFile;
	createThumbnail?: typeof createThumbnailFile;
	createObjectURL?: (blob: Blob) => string;
	revokeObjectURL?: (url: string) => void;
}

/**
 * 写真の選択を処理するハンドラを作る（#141）。
 *
 * `<input type="file">` の `onChange` は選び直すたびに発火する。縮小と
 * サムネイル生成は非同期で、重い写真ほど時間がかかるため、**先に選んだ
 * 写真の処理が後に終わって、後から選んだ写真を上書きしうる**（別の写真が
 * 添付される）。これを防ぐため、選択ごとに世代番号を振り、`await` から
 * 戻った時点で自分が最新でなければ結果を捨てる。
 *
 * 世代番号はハンドラのクロージャに閉じ込めるので、**このハンドラは一度だけ
 * 生成して使い回す**こと（呼び出しのたびに作り直すとカウンタが戻る）。
 */
export function createPhotoSelectionHandler(deps: PhotoSelectionDeps) {
	const resize = deps.resize ?? resizeImageFile;
	const createThumbnail = deps.createThumbnail ?? createThumbnailFile;
	const createObjectURL =
		deps.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
	const revokeObjectURL =
		deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));

	// 選び直すたびに増える。await から戻ったとき、自分の世代が最新の
	// 世代と一致しなければ「選び直された」と判断して結果を捨てる。
	let latestGeneration = 0;

	return async function handlePhotoChange(file: File | null): Promise<void> {
		const generation = ++latestGeneration;

		// 直前のプレビューを解放してから次に進む
		deps.setPhoto((current) => {
			if (current.status === "ready") {
				revokeObjectURL(current.previewUrl);
			}
			return file ? { status: "processing" } : { status: "empty" };
		});

		if (!file) {
			return;
		}

		const result = await resize(file);
		// 縮小している間に選び直されていたら、この結果は捨てる。
		// ここで捨てないと、後から解決した古い選択が新しい選択を上書きする。
		if (generation !== latestGeneration) {
			return;
		}
		if (!result.ok) {
			deps.setPhoto({
				status: "failed",
				message:
					result.reason === "too-large"
						? deps.getMessages().photoTooLarge
						: deps.getMessages().photoUnreadable,
			});
			return;
		}

		/*
		 * 一覧用のサムネイル（#125）。縮小済みのファイルから作る。
		 * 失敗しても null になるだけで、投稿は止めない。
		 *
		 * ここも `await` の後なので、戻った時点で世代を再確認する。
		 * `createThumbnailFile` の分だけ古い選択の処理時間が延び、後勝ちの
		 * 窓が広がる（#141）。
		 */
		const thumbnail = await createThumbnail(result.file);
		if (generation !== latestGeneration) {
			return;
		}

		// 最新であることを確かめてから初めてプレビュー URL を作る。
		// 先に作ってしまうと、捨てる側の URL が宙に浮いて解放漏れになる。
		deps.setPhoto({
			status: "ready",
			file: result.file,
			thumbnail,
			previewUrl: createObjectURL(result.file),
		});
	};
}
