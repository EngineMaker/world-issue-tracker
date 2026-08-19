import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * DOM グローバル（`window` / `document` / `HTMLElement` など）をテスト用に用意する（Issue #138）。
 *
 * このリポジトリの web コンポーネントテストは長らく `renderToStaticMarkup`
 * （SSR で静的 HTML に落とすだけ）で書かれてきた。静的 HTML は初期描画しか
 * 出さないため、Client Component の onClick / onSubmit / useEffect といった
 * **ハンドラの中身が一度も実行されない**。分岐・状態遷移・楽観的更新・
 * 送信後の副作用（例: 起票後の `clearPhoto()`）を壊しても、静的描画は
 * 変わらないので CI が緑のまま通ってしまう。
 *
 * ハンドラを実際に踏むには、React 19 の `createRoot` でクライアント描画し、
 * `@testing-library/user-event` で本物のイベントを発火させる必要があり、
 * その土台として DOM グローバルが要る。`happy-dom` は軽量で bun の
 * preload と相性が良いため採用した（Issue の対応案どおり）。
 *
 * **`bunfig.toml` の preload の先頭に置くこと。** `mock-cookies` /
 * `mock-navigation` より先に DOM を用意しないと、`@testing-library/react` の
 * import 時点で DOM が無く落ちる。preload は宣言順に評価されるので、
 * ここが最初に走る限り、どのファイルを単体で実行しても全体で実行しても
 * 同じ結果になる（既存モックが preload に置かれているのと同じ理由）。
 */
GlobalRegistrator.register();
