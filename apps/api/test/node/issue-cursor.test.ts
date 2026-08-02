import {
	buildIssueCursor,
	IssueCursorSchema,
	parseIssueCursor,
} from "@world-issue-tracker/shared";
import { describe, expect, it } from "vitest";

/**
 * カーソルの組み立てと分解は「サーバが発行した値をサーバ自身が受け付ける」
 * という往復の契約で成り立っている。ここが非対称だと、特定の行がページ境界に
 * 来た瞬間にそれより古い Issue が全件到達不能になる。
 *
 * ルート経由のテスト（issues.test.ts）は実際の行でこの往復を確かめているが、
 * DB に入れられる id の形をすべて並べるのは現実的でないため、
 * 純粋関数としての契約はここで直接押さえる。
 */
describe("issue cursor", () => {
	const CREATED_AT = "2026-01-01 00:00:01.000";

	describe("round trip", () => {
		// id は TEXT PRIMARY KEY で書式の制約が無く、区切り文字も空白も含みうる。
		const ids = [
			"0123456789abcdef0123456789abcdef",
			"we|ird|id",
			"|leading-pipe",
			"trailing-pipe|",
			"has space",
			"' OR '1'='1",
			"日本語のid",
		];

		for (const id of ids) {
			it(`builds and parses back an id: ${JSON.stringify(id)}`, () => {
				const cursor = buildIssueCursor({ created_at: CREATED_AT, id });

				// 発行したカーソルは、必ず自分のスキーマを通ること
				expect(IssueCursorSchema.safeParse(cursor).success).toBe(true);

				expect(parseIssueCursor(cursor)).toEqual({
					createdAt: CREATED_AT,
					id,
				});
			});
		}

		// DEFAULT で入った秒精度の created_at も往復できること。
		it("round trips a second-precision created_at", () => {
			const cursor = buildIssueCursor({
				created_at: "2026-01-01 00:00:01",
				id: "abc",
			});
			expect(IssueCursorSchema.safeParse(cursor).success).toBe(true);
			expect(parseIssueCursor(cursor)).toEqual({
				createdAt: "2026-01-01 00:00:01",
				id: "abc",
			});
		});
	});

	describe("schema", () => {
		it("rejects a cursor without a separator", () => {
			expect(
				IssueCursorSchema.safeParse("2026-01-01 00:00:01.000").success,
			).toBe(false);
		});

		it("rejects a cursor with an empty id", () => {
			expect(
				IssueCursorSchema.safeParse("2026-01-01 00:00:01.000|").success,
			).toBe(false);
		});

		it("rejects a cursor with a malformed timestamp", () => {
			expect(IssueCursorSchema.safeParse("2026-01-01|abc").success).toBe(false);
			expect(IssueCursorSchema.safeParse("not-a-time|abc").success).toBe(false);
		});

		it("rejects an empty cursor", () => {
			expect(IssueCursorSchema.safeParse("").success).toBe(false);
		});

		// 長さの上限はリソース保護。認証不要の公開エンドポイントに
		// 任意長の文字列を投げ込ませないためにあるので、拒否だけでなく
		// 「通る側」の境界も押さえて上限を狭める退行を拾えるようにする。
		it("rejects a cursor longer than the maximum", () => {
			const prefix = `${CREATED_AT}|`;
			const cursor = prefix + "a".repeat(257 - prefix.length);
			expect(cursor).toHaveLength(257);
			expect(IssueCursorSchema.safeParse(cursor).success).toBe(false);
		});

		it("accepts a cursor at the maximum length", () => {
			const prefix = `${CREATED_AT}|`;
			const cursor = prefix + "a".repeat(256 - prefix.length);
			expect(cursor).toHaveLength(256);
			expect(IssueCursorSchema.safeParse(cursor).success).toBe(true);
		});
	});

	// スキーマを通っていない文字列を渡されたとき、もっともらしい壊れた値を
	// 返さないこと。`indexOf` が -1 のまま slice すると、末尾 1 文字を削った
	// createdAt と元の文字列そのままの id という、静かに間違った結果になる。
	describe("parse guard", () => {
		it("throws when the separator is missing", () => {
			expect(() => parseIssueCursor("nopipe")).toThrow("Invalid cursor");
		});

		it("splits at the first separator, not the last", () => {
			expect(parseIssueCursor(`${CREATED_AT}|a|b`)).toEqual({
				createdAt: CREATED_AT,
				id: "a|b",
			});
		});
	});
});
