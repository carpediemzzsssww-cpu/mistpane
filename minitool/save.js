/* 小工具版保存：先确认，再「发笔记 / 保存到相册 / 不保存」。
   发笔记用官方 postNote（带上这张图打开发布页），存相册用 writeTempFile → saveImageToPhotosAlbum。 */
(function(){
  'use strict';
  var owner,notify,make,busy=false,picture=null,filePath=null,dialog=null,photo,msg,post,album,cancel;
  function setBusy(on){busy=on;post.disabled=album.disabled=on;if(on)owner.setAttribute('aria-busy','true');else owner.removeAttribute('aria-busy');}
  function dismiss(){if(!dialog||dialog.hidden)return;dialog.hidden=true;photo.removeAttribute('src');picture=null;filePath=null;
    document.getElementById('controls').removeAttribute('aria-hidden');document.getElementById('stage').removeAttribute('aria-hidden');owner.focus();}
  function create(){
    if(dialog)return;
    dialog=document.createElement('div');dialog.id='savePreview';dialog.hidden=true;dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','保存这扇窗');
    dialog.innerHTML='<div class="save-card" tabindex="-1"><img alt="这扇窗现在的样子"><p class="save-msg" role="status"></p><div class="save-actions">'+
      '<button type="button" class="save-primary">发笔记</button><button type="button" class="save-second">保存到相册</button><button type="button" class="save-cancel">不保存</button></div></div>';
    document.body.appendChild(dialog);
    photo=dialog.querySelector('img');msg=dialog.querySelector('.save-msg');
    post=dialog.querySelector('.save-primary');album=dialog.querySelector('.save-second');cancel=dialog.querySelector('.save-cancel');
    cancel.addEventListener('click',dismiss);
    post.addEventListener('click',function(){run('post');});
    album.addEventListener('click',function(){run('album');});
    dialog.addEventListener('click',function(e){if(e.target===dialog)dismiss();});
    dialog.addEventListener('keydown',function(e){if(e.key==='Escape')dismiss();if(e.key==='Tab'){if(e.shiftKey&&document.activeElement===post){e.preventDefault();cancel.focus();}else if(!e.shiftKey&&document.activeElement===cancel){e.preventDefault();post.focus();}}});
  }
  function tempFile(api){
    if(filePath)return Promise.resolve(filePath);
    if(typeof api.writeTempFile!=='function')return Promise.resolve(picture);
    return MIST_PLATFORM.call('writeTempFile',{data:picture}).then(function(r){if(!r||!r.filePath)throw new Error('图片未写入，请重试');filePath=r.filePath;return filePath;});
  }
  function run(kind){
    if(busy)return;setBusy(true);msg.textContent='';
    MIST_PLATFORM.ready.then(function(){
      var api=MIST_PLATFORM.api(),name=kind==='post'?'postNote':'saveImageToPhotosAlbum';
      if(!api||typeof api[name]!=='function'||(kind==='album'&&MIST_PLATFORM.version&&MIST_PLATFORM.version<9420))throw new Error('请更新小红书后再试');
      return tempFile(api).then(function(path){
        return kind==='post'?MIST_PLATFORM.call('postNote',{pageType:'photo_publish',mediaInfo:{image_resources:[{url:path}]}})
                            :MIST_PLATFORM.call('saveImageToPhotosAlbum',{filePath:path});
      });
    }).then(function(){setBusy(false);dismiss();notify(kind==='post'?'已打开发布页':'已保存到相册');},function(e){
      setBusy(false);msg.textContent=e&&e.message&&e.message.length<24?e.message:(kind==='post'?'没能打开发布页，可以再试一次':'没有存上，可以允许访问相册后再试');
    });
  }
  window.MIST_SAVE={bind:function(button,capture,toast){owner=button;make=capture;notify=toast;button.addEventListener('click',function(){
    if(busy)return;
    try{picture=make().toDataURL('image/png');filePath=null;}catch(e){notify('图片还未准备好，请稍后再试');return;}
    create();photo.src=picture;msg.textContent='';dialog.hidden=false;
    document.getElementById('controls').setAttribute('aria-hidden','true');document.getElementById('stage').setAttribute('aria-hidden','true');dialog.querySelector('.save-card').focus();
  });},isOpen:function(){return !!dialog&&!dialog.hidden;}};
})();
