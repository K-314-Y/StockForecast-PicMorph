# PNGパーツ実験室（Sprint 83）

実行画面：ゲームの「外見からキャラを作る」→「私のイラストを重ねる」→「PNGパーツ実験室を開く」、または同じローカルサーバーの /parts-lab/preview.html。

## この実験でできること

- 自作、または改変・利用許可のあるPNG/WebPを**ブラウザだけ**で合成する
- 必須：顔の描かれていない体と、背景透明の通常顔
- 任意：うれしい顔、しんぱい顔、前髪、服
- レイヤーの重ね順：体→服→顔→前髪
- 1コマを緩やかに動かす、または横並び6コマを指定速度で再生する
- 表情切替、顔だけのXY微調整（±24px）、一時停止
- 自作素材がまだない場合は、Creature Lab独自デモから派生させた固定WebP 4点を明示的に読み込んで試せる

素材は同一サイズの**キャンバス全体**で書き出す。6コマの場合は6枚を横一列に連結した画像を、体と各表情のすべてに使用する。1コマの縦横は32〜1024px。ファイルはそれぞれ最大5MB。顔・前髪・服は背景を透明にする。通常顔以外の表情を省いたときは通常顔を再利用する。

## 実装・プライバシー

実験室は固定許可された2つの静的ファイルのみを /parts-lab/preview.html と /parts-lab/preview.js で配信する。ローカル素材はファイル入力とブラウザの createImageBitmap() で読み取り、canvasの drawImage() で合成する。画像の自動アップロード、サーバー保存、外部サービス送信、トレーニング、株価取得・予測への接続は**ない**。

デモボタンを押した場合だけ、ゲーム内の固定画像4点を同じローカルサーバーから取得する。画像はページを閉じるか解除すると ImageBitmap.close() で解放する。prefers-reduced-motion 指定時は静止画像を表示。サーバー側は Content Security Policy、no-store、nosniff、X-Frame-Options DENY を適用する。ユーザーの元画像、local_state、既存の表情画像を改変しない。

## 未実装・限界

- 顔のない体画像を**自動生成・自動分割する機能ではない**。元絵に顔が描かれていると二重になる
- 1枚の静止画を使った場合、揺れるのは全体であってLive2Dのように関節や髪を個別変形できない
- 保存機能やゲーム本編のアバターへの自動適用はない。まず表示品質を確認する実験
- 6コマの顔を固定1枚で流用する方式は実装していない（コマ位置がずれるため）
- 画風やキャラが著作権上安全であることの自動判定はできない。他人の素材を少し加工しただけでは許可にならない

## 参考にした公式ドキュメント

- Unity 2D Animation Swapping individual Sprites: https://docs.unity.cn/Packages/com.unity.2d.animation@9.2/manual/CharacterParts.html
- Live2D Cubism About Material Separation: https://docs.live2d.com/en/cubism-editor-manual/divide-the-material/
- MDN createImageBitmap(): https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap
- MDN blob URL lifecycle（今回はblob URLを作らずImageBitmapを直接利用）: https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob
