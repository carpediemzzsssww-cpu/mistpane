/* 保存前先确认：定格当前窗景，只给「保存图片 / 不保存」两个选择。
   手机能用系统分享就走分享（可存到相册），否则下载，并可长按图片保存。 */
(function () {
  'use strict';
  var busy = false, dialog = null, photo = null, msg = null, primary = null, cancel = null;
  var url = null, blob = null, filename = '', owner = null, notify = null, shareFile = null;
  var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  function revoke() { if (url) { URL.revokeObjectURL(url); url = null; } blob = null; shareFile = null; }
  function download() {
    if (!url) return;
    var a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  function dismiss() {
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true; photo.removeAttribute('src'); revoke();
    document.getElementById('controls').removeAttribute('aria-hidden');
    document.getElementById('stage').removeAttribute('aria-hidden');
    owner.focus();
  }
  function createDialog() {
    if (dialog) return;
    dialog = document.createElement('div'); dialog.id = 'savePreview'; dialog.hidden = true;
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '保存这扇窗');
    dialog.innerHTML = '<div class="save-card" tabindex="-1"><img alt="这扇窗现在的样子"><p class="save-msg" role="status"></p>' +
      '<div class="save-actions"><button type="button" class="save-primary">保存图片</button><button type="button" class="save-cancel">不保存</button></div></div>';
    document.body.appendChild(dialog);
    photo = dialog.querySelector('img'); msg = dialog.querySelector('.save-msg');
    primary = dialog.querySelector('.save-primary'); cancel = dialog.querySelector('.save-cancel');
    cancel.addEventListener('click', dismiss);
    dialog.addEventListener('click', function (e) { if (e.target === dialog) dismiss(); });
    dialog.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
      if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === primary) { e.preventDefault(); cancel.focus(); }
        else if (!e.shiftKey && document.activeElement === cancel) { e.preventDefault(); primary.focus(); }
      }
    });
    primary.addEventListener('click', function () {
      if (shareFile) {
        primary.disabled = true;
        try {
          navigator.share({ files: [shareFile] }).then(function () { primary.disabled = false; dismiss(); notify('已保存'); }, function (err) {
            primary.disabled = false;
            if (!err || err.name !== 'AbortError') { shareFile = null; download(); msg.textContent = '已下载，也可以长按图片保存'; }
          });
        } catch (e) { primary.disabled = false; shareFile = null; download(); msg.textContent = '已下载，也可以长按图片保存'; }
      } else if (touch) {
        download(); msg.textContent = '已下载，也可以长按图片保存';
      } else {
        download(); dismiss(); notify('已保存图片');
      }
    });
  }
  function present() {
    createDialog(); shareFile = null; msg.textContent = '';
    try {
      var file = new File([blob], filename, { type: 'image/png' });
      if (touch && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) shareFile = file;
    } catch (e) {}
    photo.src = url; primary.disabled = false;
    dialog.hidden = false;
    document.getElementById('controls').setAttribute('aria-hidden', 'true');
    document.getElementById('stage').setAttribute('aria-hidden', 'true');
    dialog.querySelector('.save-card').focus();
  }
  function capture(makePicture) {
    if (busy) return;
    busy = true; owner.setAttribute('aria-busy', 'true');
    function done() { busy = false; owner.removeAttribute('aria-busy'); }
    try {
      var canvas = makePicture();
      canvas.toBlob(function (result) {
        done();
        if (!result) { notify('图片未能生成，请再试一次'); return; }
        revoke(); blob = result; url = URL.createObjectURL(blob);
        filename = 'mistpane-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
        present();
      }, 'image/png');
    } catch (e) { done(); notify('图片还未准备好，请稍后再试'); }
  }
  window.MIST_SAVE = {
    bind: function (button, makePicture, showToast) { owner = button; notify = showToast; button.addEventListener('click', function () { capture(makePicture); }); },
    isOpen: function () { return !!dialog && !dialog.hidden; }
  };
})();
