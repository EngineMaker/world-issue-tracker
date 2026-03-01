# Contributing to World Issue Tracker

World Issue Tracker への貢献に興味を持っていただきありがとうございます！

## 開発環境セットアップ

1. リポジトリをフォーク & クローン

```bash
git clone https://github.com/<your-username>/world-issue-tracker.git
cd world-issue-tracker
```

2. 依存関係をインストール

```bash
bun install
```

3. 環境変数を設定

```bash
# API
cp apps/api/.dev.vars.example apps/api/.dev.vars

# Web
cp apps/web/.env.local.example apps/web/.env.local
```

4. D1 のローカルマイグレーションを適用

```bash
cd apps/api && bun wrangler d1 migrations apply world-issue-tracker --local
```

5. 開発サーバーを起動

```bash
bun dev
```

## ブランチ戦略

- `main` ブランチが本番環境に自動デプロイされます
- 新機能やバグ修正は feature ブランチを作成して作業してください
- ブランチ名の例: `feat/add-map-view`, `fix/issue-creation-error`

```bash
git checkout -b feat/your-feature-name
```

## コミットメッセージ規約

[Conventional Commits](https://www.conventionalcommits.org/) に従ってください。

```
<type>: <description>

[optional body]
```

### Type 一覧

| Type | 用途 |
|------|------|
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `docs` | ドキュメントのみの変更 |
| `refactor` | リファクタリング（機能変更なし） |
| `test` | テストの追加・修正 |
| `chore` | ビルドプロセスやツールの変更 |

### 例

```
feat: add issue creation form
fix: resolve map marker positioning error
docs: update setup instructions in README
```

## コードスタイル

- **Biome** でリント・フォーマットを管理しています
- インデントは **タブ** を使用
- コミット前にリントを実行してください:

```bash
bun run lint
```

## テスト

変更に関連するテストを追加・更新してください。

```bash
# 全テスト実行
bun test

# 特定パッケージのテスト
cd apps/api && bun test
```

## Pull Request の出し方

1. feature ブランチで作業し、コミットをまとめる
2. `bun run lint` と `bun test` がパスすることを確認
3. main ブランチに向けて PR を作成
4. PR の説明に以下を含めてください:
   - 変更の概要
   - 関連する Issue 番号（あれば）
   - テスト方法

## PR レビュー基準

- CI（lint + typecheck + test）がすべてパスしていること
- 既存のコードスタイルと一貫性があること
- 適切なテストが含まれていること
- 変更が最小限で、目的が明確であること
