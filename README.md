# World Issue Tracker

> 地球のバグを、みんなで可視化して、みんなで直す

ソフトウェア開発の Issue Tracker を現実世界に適用し、個人の困りごとから国際問題まで、あらゆるスコープの課題を一つのプラットフォームで可視化・解決に導くサービスです。

**裏テーマ**: 隣り合う Issue が視野を広げる。blame ではなく fix。対立ではなく issue。

## コアコンセプト

- **Issue のスコープ階層**: 個人 → 近隣・コミュニティ → 自治体 → 国 → 世界
- **ライフサイクル**: `Open → Triaged → In Progress → Review → Resolved → Closed`

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| モノレポ | Turborepo |
| API サーバー | Hono (TypeScript) → Cloudflare Workers |
| フロントエンド | Next.js (App Router) → Cloudflare Pages (OpenNext) |
| データベース | Cloudflare D1 (SQLite 互換) |
| 認証 | Clerk |
| 共有型定義 | Zod スキーマ (`packages/shared`) |
| リンター/フォーマッター | Biome |
| テスト | Vitest |
| IaC | wrangler.jsonc |
| 言語 | TypeScript 統一 |

## ディレクトリ構成

```
world-issue-tracker/
├── apps/
│   ├── api/          # Hono API (Cloudflare Workers)
│   └── web/          # Next.js フロントエンド (Cloudflare Pages)
├── packages/
│   └── shared/       # Zod スキーマ、型定義、バリデーション
├── turbo.json
├── package.json
└── CLAUDE.md
```

## ローカル開発セットアップ

### 前提条件

- [Bun](https://bun.sh/) v1.3.8+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (bun install で自動インストール)

### 手順

```bash
# 依存関係をインストール
bun install

# API 用の環境変数を設定
cp apps/api/.dev.vars.example apps/api/.dev.vars
# apps/api/.dev.vars に Clerk のシークレットキーを記入

# Web 用の環境変数を設定
cp apps/web/.env.local.example apps/web/.env.local
# apps/web/.env.local に Clerk のキーを記入
# NEXT_PUBLIC_API_URL はローカル開発なら既定値のままでよい

# D1 のローカルマイグレーションを適用
cd apps/api && bun wrangler d1 migrations apply world-issue-tracker --local && cd ../..

# 開発サーバーを起動
bun dev
```

API は `http://localhost:8787`、Web は `http://localhost:3000` で起動します。

## デプロイ

本番環境は Cloudflare にデプロイされています:

| サービス | URL |
|---------|-----|
| API | https://world-issue-tracker-api.mktoho.workers.dev |
| Web | https://world-issue-tracker-web.mktoho.workers.dev |

> **独自ドメインへの切り替えを準備中（#98）。**
> Web の入口は `https://issues.emaker.dev` になる予定です。Clerk の本番
> インスタンスは独自ドメインを必須としており、`*.workers.dev` では本番キー
> （`pk_live_` / `sk_live_`）を使えないため。
>
> コード側の受け入れ準備（CORS の許可オリジン、Clerk の `authorizedParties`）は
> 済んでいて、値は `packages/shared` の `PRODUCTION_WEB_ORIGIN` に集約してあります。
> DNS と Clerk 側の設定が終わって実際に切り替わったら、この表を更新すること。

### GitHub Actions による自動デプロイ

`main` ブランチへの push 時に自動デプロイが実行されます。

以下のシークレットを GitHub リポジトリの Settings > Secrets に設定してください:

- `CLOUDFLARE_API_TOKEN` — Cloudflare API トークン（Workers + D1 の編集権限）
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare アカウント ID
- `CLERK_SECRET_KEY` — Clerk シークレットキー（Web ビルド用）
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk パブリッシャブルキー（Web ビルド用）

#### Clerk は本番用インスタンスのキーを使うこと

本番へ出すキーは **`pk_live_` / `sk_live_` で始まる本番インスタンスのもの**である
必要があります。開発用インスタンスのキー（`pk_test_` / `sk_test_`）でも認証は
一見動きますが、Clerk 側に利用者数の上限があり、**上限に達するとサインインできなく
なります**。サインイン画面にも「Development mode」が表示されます（#98）。

開発用キーはローカル・CI・本番のどこでも同じように動くため、テストも型検査も
ビルドも通ってしまいます。そこで本番デプロイの経路にだけ検査を置いています:

- **Web**: `bun run deploy` が `apps/web/scripts/check-clerk-keys.ts` を先に実行し、
  `pk_live_` / `sk_live_` でなければビルドへ進まずに失敗します
- **API**: キーは Workers Secrets にあり、値は書き込み専用で読み出せないため
  （`wrangler secret list` が返すのは名前と型だけ）、ビルド前には止められません。
  代わりに**デプロイの直後に、出したばかりの API 自身へ種別を聞きます**
  （`apps/api/scripts/verify-clerk-instance.ts` が `GET /health/auth` を叩く）。
  開発用インスタンスならワークフローが失敗します。
  併せて実行時にも開発用キーで動いていると警告をログへ出します
  （Worker インスタンスごとに 1 回。Observability / `wrangler tail` で確認できます）

`GET /health/auth` が返すのは**種別だけ**（`production` / `development` / `unset`）で、
キーの値も断片も返しません。判定は接頭辞しか見ないので種別以上の情報は不要です。

`deploy-web` は `deploy-api` の完了を待ちます（`needs: deploy-api`）。並走させると、
片方だけ本番用インスタンスに切り替わった状態で本番が動く時間帯ができてしまうためです。

検査は接頭辞が `pk_live_` / `sk_live_` であることだけを見ます。**判定できない値
（未設定、空、想定外の接頭辞）は「本番用ではない」として扱い、デプロイを止めます。**
Clerk が接頭辞の形式を変えた場合、キーが正しくてもデプロイが全面的に止まることになりますが、
検査が黙って無効化されるよりは安全側に倒す判断として意図的にこうしています。その状況に当たったら
`packages/shared/src/index.ts` の `clerkKeyKind()` を更新してください。

**web と api は必ず同時に切り替えてください。** 片方だけだとトークンを発行した先と
検証する先が食い違い、認証が通らなくなります。API 側は
`wrangler secret put CLERK_SECRET_KEY` / `wrangler secret put CLERK_PUBLISHABLE_KEY`
（`apps/api` で実行）で設定します。

なお **Clerk の開発用インスタンスと本番インスタンスはユーザーを共有しません。**
切り替えると既存のログイン済みユーザーは引き継がれず、サインアップし直しになります。

Web が参照する API の URL (`NEXT_PUBLIC_API_URL`) はシークレットではないため、
設定ファイルに直接書いています。デプロイ先を変えたときは **2 箇所**を更新してください:

- `.github/workflows/deploy.yml` — ビルド時。Client Component のバンドルに埋め込まれる
- `apps/web/wrangler.jsonc` の `vars` — 実行時。Server Component が `process.env` から読む

`NEXT_PUBLIC_` の値がバンドルへ埋め込まれるのは Client Component だけです。
一覧を取得する Server Component（`app/page.tsx`、`app/issues/page.tsx`）は
Workers 上で `process.env` を評価するため、`vars` が無いと既定値の
`http://localhost:8787` へ fetch して一覧が取得できなくなります。
片方だけ更新すると値がズレるので、両者の一致は
`apps/api/test/node/web-runtime-env.test.ts` で検査しています。

D1 のマイグレーションは、API のデプロイに先立って自動で適用されます
(`.github/workflows/deploy.yml` の `Apply D1 migrations`)。
新しいテーブルを前提にしたコードが先に本番へ出ないよう、順序を入れ替えないでください。

### 手動デプロイ

```bash
# API
# マイグレーションを先に適用する。`--remote` を忘れるとローカルの
# .wrangler に当たるだけで、本番の D1 は変わらないまま成功扱いになる
cd apps/api
bun wrangler d1 migrations apply world-issue-tracker --remote
bun wrangler deploy
cd ../..

# Web
# NEXT_PUBLIC_API_URL を明示すること。指定しないと .env.local の値
# （ローカル開発では http://localhost:8787）がバンドルに焼き付き、
# 本番サイトが利用者のブラウザから localhost へ投げて起票が全件失敗する。
# 一覧側（Server Component）は wrangler.jsonc の vars が使われる
cd apps/web && NEXT_PUBLIC_API_URL=https://world-issue-tracker-api.mktoho.workers.dev bun run deploy
```

### デプロイ後の確認

**本番環境には確認用の Issue を起票しないでください。**
投稿された Issue はトップページの「最近の Issue」にそのまま並びます。件数が少ないうちは
テストデータがトップの大半を占め、初回訪問者には「運用されていないサービス」に見えます。
実際に「テスト Issue — デプロイ確認用」が本番トップに残り続けていました（#69）。

デプロイが成功したかどうかは、書き込みをせずに次の 2 つで確認できます。

```bash
# API が起動していて D1 にも繋がっているか（health は D1 に SELECT を投げている）
# 異常時は 500 + {"status":"unhealthy"} なので、-f で終了コードに出す
curl -fs https://world-issue-tracker-api.mktoho.workers.dev/health
# => {"status":"healthy"}

# 一覧が取得できるか（GET /issues は公開エンドポイント。認証不要）
curl -fs "https://world-issue-tracker-api.mktoho.workers.dev/issues?limit=1"

# Web から API へ実際に到達できているか（Server Component の fetch 経路の確認）
curl -fs https://world-issue-tracker-web.mktoho.workers.dev/ | grep -q "最近の Issue" && echo OK
```

起票・更新まで含めて確かめたい場合は、本番ではなくローカル（`bun dev`）か、
`--local` の D1 に対して行ってください。

### 本番に入れてしまったデータを消す

やむを得ず本番へ書き込んでしまった場合は、その場で消してください。
`DELETE /issues/:id` は所有者本人しか実行できず、確認用のアカウントが違ったり
`user_id` が入っていない行だと 403 になるため、確実なのは D1 を直接操作する経路です。

```bash
cd apps/api

# 1. 消す対象を先に特定する（id を確認せずに DELETE を打たない）
bun wrangler d1 execute world-issue-tracker --remote \
  --command "SELECT id, title, user_id, created_at FROM issues ORDER BY created_at DESC LIMIT 10"

# 2. id を指定して 1 件だけ消す
bun wrangler d1 execute world-issue-tracker --remote \
  --command "DELETE FROM issues WHERE id = '<上で確認した id>'"

# 3. 消えたことを確認する（公開 API 側にも反映されているか）
curl -fs "https://world-issue-tracker-api.mktoho.workers.dev/issues?limit=50"
```

`--remote` を付けないとローカルの D1 が対象になり、本番のデータは残ったままになります。
逆に `WHERE` を省いたり条件を緩めたりすると実データを巻き込むため、
**必ず `id` で 1 件を指定**してください。

## ライセンス

[MIT](LICENSE)
