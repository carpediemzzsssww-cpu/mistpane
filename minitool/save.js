/* Native photo saving replaces unsupported browser file saving in this build. */
(function(){
  'use strict';
  var owner,notify,make,busy=false,picture=null,filePath=null,dialog=null,photo,action,close,note;
  function dismiss(){if(!dialog)return;dialog.hidden=true;photo.removeAttribute('src');picture=null;filePath=null;owner.focus();}
  function preview(message){
    if(!dialog){dialog=document.createElement('div');dialog.id='savePreview';dialog.hidden=true;dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','保存当前窗景');
      dialog.innerHTML='<div class="save-card"><button type="button" class="save-close" aria-label="返回画窗">×</button><img alt="待保存的窗景"><p></p><button type="button" class="save-action">重试保存</button></div>';
      document.body.appendChild(dialog);photo=dialog.querySelector('img');action=dialog.querySelector('.save-action');close=dialog.querySelector('.save-close');note=dialog.querySelector('p');
      close.addEventListener('click',dismiss);action.addEventListener('click',function(){persist();});
      dialog.addEventListener('click',function(e){if(e.target===dialog)dismiss();});
      dialog.addEventListener('keydown',function(e){if(e.key==='Escape')dismiss();if(e.key==='Tab'){if(e.shiftKey&&document.activeElement===close){e.preventDefault();action.focus();}else if(!e.shiftKey&&document.activeElement===action){e.preventDefault();close.focus();}}});
    }
    photo.src=picture;note.textContent=message;dialog.hidden=false;close.focus();
  }
  function persist(){
    if(busy)return;busy=true;owner.setAttribute('aria-busy','true');if(action)action.disabled=true;
    MIST_PLATFORM.ready.then(function(){
      var api=MIST_PLATFORM.api();
      if(MIST_PLATFORM.version<9420||!api||typeof api.saveImageToPhotosAlbum!=='function')throw new Error('请更新小红书后重试，当前画面已保留');
      if(filePath)return filePath;
      if(typeof api.writeTempFile==='function')return MIST_PLATFORM.call('writeTempFile',{data:picture}).then(function(r){if(!r||!r.filePath)throw new Error('图片未写入，请重试');filePath=r.filePath;return filePath;});
      return picture;
    }).then(function(path){return MIST_PLATFORM.call('saveImageToPhotosAlbum',{filePath:path});}).then(function(){dismiss();picture=null;filePath=null;notify('已保存到相册');},function(e){
      preview(e&&e.message?e.message:'保存未完成，画面已保留，可授权相册后重试');
    }).then(function(){busy=false;owner.removeAttribute('aria-busy');if(action)action.disabled=false;});
  }
  window.MIST_SAVE={bind:function(button,capture,toast){owner=button;make=capture;notify=toast;button.addEventListener('click',function(){
    if(busy)return;
    try{picture=make().toDataURL('image/png');filePath=null;persist();}catch(e){notify('图片还未准备好，请稍后再试');}
  });},isOpen:function(){return !!dialog&&!dialog.hidden;}};
})();
