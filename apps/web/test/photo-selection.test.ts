/**
 * 写真選択の競合ガード（#141）のテスト。
 *
 * `<input type="file">` は選び直すたびに `onChange` を発火する。縮小と
 * サムネイル生成は非同期で、重い写真ほど時間がかかるため、**先に選んだ
 * 写真の処理が後に終わって、後から選んだ写真を上書きしうる**。これを
 * 世代ガードで防いでいることを確かめる。
 *
 * 実ブラウザの `createImageBitmap` / `<canvas>` はテスト環境に無いので、
 * `resize` / `createThumbnail` を差し替えて解決の「順序」を制御する。
 * 速さには依存しない（`setTimeout(0)` はマイクロタスクを流し切るための
 * マクロタスク境界で、待ち時間の長さは結果に影響しない）。
 */

import { describe, expect, it } from "bun:test";
import type { Dispatch, SetStateAction } from "react";
import type { ResizeResult } from "../src/lib/photo";
import {
	createPhotoSelectionHandler,
	type PhotoState,
} from "../src/lib/photo-selection";

/** `setPhoto` の代わり。値でも updater でも受け、現在値を保持する。 */
function makePhotoStore() {
	let current: PhotoState = { status: "empty" };
	const setPhoto = ((action: SetStateAction<PhotoState>) => {
		current = typeof action === "function" ? action(current) : action;
	}) as Dispatch<SetStateAction<PhotoState>>;
	return {
		setPhoto,
		get current() {
			return current;
		},
	};
}

/**
 * 呼び出しごとに解決を保留する関数を作る。テスト側が `calls[i].resolve` で
 * 好きな順に解決できるので、非同期の解決順を組み立てられる。
 */
function deferredFactory<Arg, Ret>() {
	const calls: { arg: Arg; resolve: (value: Ret) => void }[] = [];
	const fn = (arg: Arg): Promise<Ret> =>
		new Promise<Ret>((resolve) => {
			calls.push({ arg, resolve });
		});
	return { fn, calls };
}

/** 保留していた promise を流し切る（マイクロタスクをすべて処理させる）。 */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFile(name: string, size: number): File {
	return new File([new Uint8Array(size)], name, { type: "image/jpeg" });
}

const MESSAGES = {
	photoTooLarge: "大きすぎます",
	photoUnreadable: "読めません",
};

describe("createPhotoSelectionHandler — 選び直しの競合", () => {
	it("縮小中に選び直すと、後から選んだ写真が残る（先の写真で上書きしない）", async () => {
		const resize = deferredFactory<File, ResizeResult>();
		const thumb = deferredFactory<File, File | null>();
		const created: string[] = [];
		const revoked: string[] = [];
		const store = makePhotoStore();

		const { handlePhotoChange: handle } = createPhotoSelectionHandler({
			setPhoto: store.setPhoto,
			getMessages: () => MESSAGES,
			resize: resize.fn as typeof import("../src/lib/photo").resizeImageFile,
			createThumbnail:
				thumb.fn as typeof import("../src/lib/photo").createThumbnailFile,
			createObjectURL: (blob) => {
				const url = `blob:${(blob as File).name}`;
				created.push(url);
				return url;
			},
			revokeObjectURL: (url) => {
				revoked.push(url);
			},
		});

		const fileA = makeFile("A.jpg", 4_000_000); // 重い＝処理が遅い想定
		const fileB = makeFile("B.jpg", 100_000); // 軽い＝処理が速い想定
		const resizedA = makeFile("resized-A.jpg", 900_000);
		const resizedB = makeFile("resized-B.jpg", 80_000);

		// A を選び、処理が終わる前に B を選び直す
		const pA = handle(fileA);
		const pB = handle(fileB);

		expect(resize.calls.map((c) => c.arg)).toEqual([fileA, fileB]);

		// B（後の選択）が先に解決する
		resize.calls[1].resolve({ ok: true, file: resizedB });
		await flush();
		expect(thumb.calls.map((c) => c.arg)).toEqual([resizedB]);
		thumb.calls[0].resolve(null);
		await flush();

		// この時点で B が ready になっている
		expect(store.current.status).toBe("ready");

		// 遅れて A（先の選択）が解決する。これが B を上書きしてはいけない
		resize.calls[0].resolve({ ok: true, file: resizedA });
		await Promise.all([pA, pB]);
		await flush();

		expect(store.current.status).toBe("ready");
		if (store.current.status !== "ready") throw new Error("unreachable");
		// 残っているのは B。捨てた A ではない
		expect(store.current.file).toBe(resizedB);
		expect(store.current.previewUrl).toBe("blob:resized-B.jpg");

		// A のサムネイル生成もプレビュー URL 生成も走らない（世代ガードで捨てた）
		expect(thumb.calls.map((c) => c.arg)).toEqual([resizedB]);
		expect(created).toEqual(["blob:resized-B.jpg"]);
		// 捨てた A の URL が宙に浮いていない（そもそも作っていない）
		expect(revoked).toEqual([]);
	});

	it("サムネイル生成中に選び直しても、後から選んだ写真が残る", async () => {
		const resize = deferredFactory<File, ResizeResult>();
		const thumb = deferredFactory<File, File | null>();
		const created: string[] = [];
		const store = makePhotoStore();

		const { handlePhotoChange: handle } = createPhotoSelectionHandler({
			setPhoto: store.setPhoto,
			getMessages: () => MESSAGES,
			resize: resize.fn as typeof import("../src/lib/photo").resizeImageFile,
			createThumbnail:
				thumb.fn as typeof import("../src/lib/photo").createThumbnailFile,
			createObjectURL: (blob) => {
				const url = `blob:${(blob as File).name}`;
				created.push(url);
				return url;
			},
			revokeObjectURL: () => {},
		});

		const resizedA = makeFile("resized-A.jpg", 900_000);
		const resizedB = makeFile("resized-B.jpg", 80_000);

		const pA = handle(makeFile("A.jpg", 4_000_000));
		// A の縮小が終わり、サムネイル生成に入る
		resize.calls[0].resolve({ ok: true, file: resizedA });
		await flush();
		expect(thumb.calls.map((c) => c.arg)).toEqual([resizedA]);

		// A のサムネイル生成中に B を選び直す
		const pB = handle(makeFile("B.jpg", 100_000));
		resize.calls[1].resolve({ ok: true, file: resizedB });
		await flush();
		thumb.calls[1].resolve(null); // B のサムネイル
		await flush();
		// 遅れて A のサムネイルが解決する
		thumb.calls[0].resolve(null);
		await Promise.all([pA, pB]);
		await flush();

		if (store.current.status !== "ready") throw new Error("not ready");
		expect(store.current.file).toBe(resizedB);
		expect(created).toEqual(["blob:resized-B.jpg"]);
	});

	it("古い選択が失敗しても、新しい選択の ready を潰さない", async () => {
		const resize = deferredFactory<File, ResizeResult>();
		const thumb = deferredFactory<File, File | null>();
		const store = makePhotoStore();

		const { handlePhotoChange: handle } = createPhotoSelectionHandler({
			setPhoto: store.setPhoto,
			getMessages: () => MESSAGES,
			resize: resize.fn as typeof import("../src/lib/photo").resizeImageFile,
			createThumbnail:
				thumb.fn as typeof import("../src/lib/photo").createThumbnailFile,
			createObjectURL: (blob) => `blob:${(blob as File).name}`,
			revokeObjectURL: () => {},
		});

		const resizedB = makeFile("resized-B.jpg", 80_000);
		const pA = handle(makeFile("A.jpg", 9_000_000));
		const pB = handle(makeFile("B.jpg", 100_000));

		// B が成功して ready になる
		resize.calls[1].resolve({ ok: true, file: resizedB });
		await flush();
		thumb.calls[0].resolve(null);
		await flush();
		expect(store.current.status).toBe("ready");

		// 遅れて A が「大きすぎ」で失敗する。failed で ready を上書きしてはいけない
		resize.calls[0].resolve({ ok: false, reason: "too-large" });
		await Promise.all([pA, pB]);
		await flush();

		expect(store.current.status).toBe("ready");
	});
});

describe("createPhotoSelectionHandler — 単一選択の基本動作", () => {
	it("選ぶと processing を経て ready になる", async () => {
		const resize = deferredFactory<File, ResizeResult>();
		const thumb = deferredFactory<File, File | null>();
		const store = makePhotoStore();

		const { handlePhotoChange: handle } = createPhotoSelectionHandler({
			setPhoto: store.setPhoto,
			getMessages: () => MESSAGES,
			resize: resize.fn as typeof import("../src/lib/photo").resizeImageFile,
			createThumbnail:
				thumb.fn as typeof import("../src/lib/photo").createThumbnailFile,
			createObjectURL: (blob) => `blob:${(blob as File).name}`,
			revokeObjectURL: () => {},
		});

		const resized = makeFile("resized.jpg", 80_000);
		const thumbnail = makeFile("thumb.jpg", 20_000);
		const p = handle(makeFile("photo.jpg", 4_000_000));

		expect(store.current.status).toBe("processing");

		resize.calls[0].resolve({ ok: true, file: resized });
		await flush();
		thumb.calls[0].resolve(thumbnail);
		await p;
		await flush();

		if (store.current.status !== "ready") throw new Error("not ready");
		expect(store.current.file).toBe(resized);
		expect(store.current.thumbnail).toBe(thumbnail);
		expect(store.current.previewUrl).toBe("blob:resized.jpg");
	});

	it("縮小に失敗すると failed（理由に応じた文言）になる", async () => {
		const resize = deferredFactory<File, ResizeResult>();
		const store = makePhotoStore();

		const { handlePhotoChange: handle } = createPhotoSelectionHandler({
			setPhoto: store.setPhoto,
			getMessages: () => MESSAGES,
			resize: resize.fn as typeof import("../src/lib/photo").resizeImageFile,
			createObjectURL: (blob) => `blob:${(blob as File).name}`,
			revokeObjectURL: () => {},
		});

		const p = handle(makeFile("broken.gif", 1000));
		resize.calls[0].resolve({ ok: false, reason: "unsupported" });
		await p;
		await flush();

		if (store.current.status !== "failed") throw new Error("not failed");
		expect(store.current.message).toBe(MESSAGES.photoUnreadable);
	});

	it("選択を解除すると empty に戻し、直前のプレビュー URL を解放する", async () => {
		const resize = deferredFactory<File, ResizeResult>();
		const thumb = deferredFactory<File, File | null>();
		const revoked: string[] = [];
		const store = makePhotoStore();

		const { handlePhotoChange: handle } = createPhotoSelectionHandler({
			setPhoto: store.setPhoto,
			getMessages: () => MESSAGES,
			resize: resize.fn as typeof import("../src/lib/photo").resizeImageFile,
			createThumbnail:
				thumb.fn as typeof import("../src/lib/photo").createThumbnailFile,
			createObjectURL: (blob) => `blob:${(blob as File).name}`,
			revokeObjectURL: (url) => {
				revoked.push(url);
			},
		});

		// まず 1 枚 ready にする
		const p = handle(makeFile("photo.jpg", 4_000_000));
		resize.calls[0].resolve({
			ok: true,
			file: makeFile("resized.jpg", 80_000),
		});
		await flush();
		thumb.calls[0].resolve(null);
		await p;
		await flush();
		expect(store.current.status).toBe("ready");

		// 選択解除（null）。直前の ready の URL を解放して empty に戻す
		await handle(null);
		expect(store.current.status).toBe("empty");
		expect(revoked).toEqual(["blob:resized.jpg"]);
	});

	it("ready の状態から選び直すと、直前のプレビュー URL を解放する", async () => {
		const resize = deferredFactory<File, ResizeResult>();
		const thumb = deferredFactory<File, File | null>();
		const revoked: string[] = [];
		const store = makePhotoStore();

		const { handlePhotoChange: handle } = createPhotoSelectionHandler({
			setPhoto: store.setPhoto,
			getMessages: () => MESSAGES,
			resize: resize.fn as typeof import("../src/lib/photo").resizeImageFile,
			createThumbnail:
				thumb.fn as typeof import("../src/lib/photo").createThumbnailFile,
			createObjectURL: (blob) => `blob:${(blob as File).name}`,
			revokeObjectURL: (url) => {
				revoked.push(url);
			},
		});

		const p1 = handle(makeFile("first.jpg", 4_000_000));
		resize.calls[0].resolve({
			ok: true,
			file: makeFile("resized-1.jpg", 80_000),
		});
		await flush();
		thumb.calls[0].resolve(null);
		await p1;
		await flush();

		// 落ち着いた状態から、別の写真に選び直す
		handle(makeFile("second.jpg", 4_000_000));
		// 選び直した瞬間に直前の URL が解放される
		expect(revoked).toEqual(["blob:resized-1.jpg"]);
	});
});

describe("createPhotoSelectionHandler — clearPhoto と世代の共有", () => {
	it("ready を取り消すと empty に戻し、プレビュー URL を解放する", async () => {
		const resize = deferredFactory<File, ResizeResult>();
		const thumb = deferredFactory<File, File | null>();
		const revoked: string[] = [];
		const store = makePhotoStore();

		const { handlePhotoChange: handle, clearPhoto } =
			createPhotoSelectionHandler({
				setPhoto: store.setPhoto,
				getMessages: () => MESSAGES,
				resize: resize.fn as typeof import("../src/lib/photo").resizeImageFile,
				createThumbnail:
					thumb.fn as typeof import("../src/lib/photo").createThumbnailFile,
				createObjectURL: (blob) => `blob:${(blob as File).name}`,
				revokeObjectURL: (url) => {
					revoked.push(url);
				},
			});

		const p = handle(makeFile("photo.jpg", 4_000_000));
		resize.calls[0].resolve({
			ok: true,
			file: makeFile("resized.jpg", 80_000),
		});
		await flush();
		thumb.calls[0].resolve(null);
		await p;
		await flush();
		expect(store.current.status).toBe("ready");

		clearPhoto();
		expect(store.current.status).toBe("empty");
		expect(revoked).toEqual(["blob:resized.jpg"]);
	});

	// 指摘1（レビュー）: 送信成功後に clearPhoto で empty にした直後、送信中に
	// 選び直して進行中だった処理が遅れて解決すると、消したはずの写真が復活する。
	// clearPhoto が世代を進めることで、進行中の選択が破棄されることを見る。
	it("clearPhoto の後に進行中の選択が解決しても、写真は復活しない", async () => {
		const resize = deferredFactory<File, ResizeResult>();
		const thumb = deferredFactory<File, File | null>();
		const store = makePhotoStore();

		const { handlePhotoChange: handle, clearPhoto } =
			createPhotoSelectionHandler({
				setPhoto: store.setPhoto,
				getMessages: () => MESSAGES,
				resize: resize.fn as typeof import("../src/lib/photo").resizeImageFile,
				createThumbnail:
					thumb.fn as typeof import("../src/lib/photo").createThumbnailFile,
				createObjectURL: (blob) => `blob:${(blob as File).name}`,
				revokeObjectURL: () => {},
			});

		// 送信中に写真を選び直した想定。縮小が進行中のまま…
		const p = handle(makeFile("late.jpg", 4_000_000));
		expect(store.current.status).toBe("processing");

		// …送信が成功して取り消される
		clearPhoto();
		expect(store.current.status).toBe("empty");

		// 遅れて選び直し分が解決する。これが empty を上書きしてはいけない
		resize.calls[0].resolve({
			ok: true,
			file: makeFile("resized.jpg", 80_000),
		});
		await flush();

		// 世代が古いので resize 直後で捨てられ、サムネイル段に進まない。
		// ここを `await p` の前に確かめる。clearPhoto が世代を進めない実装だと
		// この選択はサムネイル生成へ進み（thumb が呼ばれ）、`await p` は
		// 未解決のサムネイルで止まってしまう。順序を保って明示的に落とす
		expect(thumb.calls.length).toBe(0);
		expect(store.current.status).toBe("empty");

		// 正しい実装なら resize 直後の世代チェックで return 済み＝ p も解決済み
		await p;
		expect(store.current.status).toBe("empty");
	});
});
