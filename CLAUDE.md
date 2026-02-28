# World Issue Tracker

## プロジェクト概要

「地球のバグを、みんなで可視化して、みんなで直す」

ソフトウェア開発の Issue Tracker を現実世界に適用し、個人の困りごとから国際問題まで、あらゆるスコープの課題を一つのプラットフォームで可視化・解決に導くサービス。

## コアコンセプト

- **Issue のスコープ階層**: 個人 → 近隣・コミュニティ → 自治体 → 国 → 世界
- **ライフサイクル**: `Open → Triaged → In Progress → Review → Resolved → Closed`
- **裏テーマ**: 隣り合う Issue が視野を広げる。blame ではなく fix。対立ではなく issue

## 主要機能

1. **多言語 Issue 起票** — 母国語で書ける、LLM自動翻訳、位置情報で地図プロット
2. **スコープ別の解決メカニズム** — 個人マッチング、クラファン、陳情テンプレート、NGO連携
3. **契約・決済統合** — 簡易契約書自動生成、エスクロー決済
4. **世界地図ダッシュボード** — ヒートマップ、カテゴリフィルタ、スコープ別ズーム

## 技術スタック

- **モノレポ**: Turborepo
- **API サーバー**: Hono (TypeScript) → Cloudflare Workers
- **フロントエンド**: Next.js (App Router) → Cloudflare Pages (OpenNext)
- **データベース**: Cloudflare D1 (SQLite互換)
- **共有型定義**: Zod スキーマ → packages/shared
- **IaC**: wrangler.jsonc
- **言語**: TypeScript 統一

## ディレクトリ構成（予定）

```
world-issue-tracker/
├── apps/
│   ├── api/          # Hono API (Cloudflare Workers)
│   │   ├── src/
│   │   └── wrangler.jsonc
│   └── web/          # Next.js フロントエンド (Cloudflare Pages)
│       └── src/
├── packages/
│   └── shared/       # Zod スキーマ、型定義、バリデーション
├── turbo.json
├── package.json      # ワークスペースルート
└── CLAUDE.md
```

## MVP（フェーズ1）スコープ

1都市での実証を想定:

- Issue の起票（位置情報 + カテゴリ + 写真）
- 地図上の可視化（MapLibre GL JS or similar）
- コメント・リアクション
- 簡易マッチング（「手伝います」ボタン）
- ユーザー認証（メール/SNSログイン）
- 日本語・英語の2言語対応

## 開発ルール

- パッケージマネージャー: **bun** を使用
- テスト: vitest
- リンター/フォーマッター: Biome
- コミットメッセージ: Conventional Commits
- 環境変数は `.dev.vars` (Wrangler) / `.env.local` (Next.js) で管理、リポジトリにコミットしない

## Notion 企画ドキュメント

詳細な企画書は Notion にあります（Notion MCP でアクセス可能）:
- メインページ: `315e251a-8601-811c-be5c-e9fd0d84d4e9`
- 親ページ「やりたいこと」: `315e251a-8601-8004-a250-d34e0a3d1204`
