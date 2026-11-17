# work-board — Claude Code の作業ボード

Claude デスクトップアプリ（Code タブ）のチャット横に常駐するパネル。次を表示する。

- 自分のタスク（追加・完了・削除。セッションをまたいで残る）
- このセッションで Claude が進めているタスク
- 他のセッション一覧（作業中／待ち／完了のステータス、メモ、直近の依頼の一行要約）

上部のタブで各セクションへ飛べる。60秒ごとに自動更新。閉じた時は `/board` で再表示。

## インストール

ターミナルの Claude Code セッションのプロンプトで:

```
/plugin install work-board --marketplace kekeke0906-prog/work-board
```

シェルから:

```
claude plugin install work-board --marketplace kekeke0906-prog/work-board
```

デスクトップアプリ（`/plugin` が使えない場合）: プロンプト横の + → Plugins → Add marketplace に `kekeke0906-prog/work-board` を入れて → Add plugin。

非公開リポジトリは、GitHub でこのリポジトリを読める人で、かつそのマシンに github.com の git 認証（SSH キー、または `gh auth login` のあと `gh auth setup-git`）がある場合だけインストールできる。

## 構成

- `.claude-plugin/plugin.json` — マニフェスト
- `hooks/hooks.json` / `hooks/register.tsx` — フックモジュール本体
- `types/index.d.ts` — `$.state` に置く値の型
