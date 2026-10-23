// サンプルプラグイン。VC.addButton(id, 文字, ヒント, 押したとき) でボタンを足せる。
VC.addButton('hello-btn', '👋', 'ハローサンプル', () => {
  const s = VC.session();
  VC.toast(s ? '今の会話: ' + s.name : '会話が開かれていません');
});
