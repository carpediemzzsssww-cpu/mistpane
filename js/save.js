/* Save an exact, local snapshot. Mobile previews keep a fresh tap for system sharing. */
(function () {
  'use strict';
  var busy=false,dialog=null,photo=null,save=null,close=null,note=null;
  var url=null,blob=null,filename='',owner=null,notify=null,shareFile=null;
  function revoke() { if(url){URL.revokeObjectURL(url);url=null;}blob=null;shareFile=null; }
  function download() {
    if(!url)return;
    var a=document.createElement('a');a.href=url;a.download=filename;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
  }
  function dismiss() {
    if(!dialog||dialog.hidden)return;
    dialog.hidden=true;photo.removeAttribute('src');revoke();
    document.getElementById('controls').removeAttribute('aria-hidden');
    document.getElementById('stage').removeAttribute('aria-hidden');
    owner.focus();
  }
  function createDialog() {
    if(dialog)return;
    dialog=document.createElement('div');dialog.id='savePreview';dialog.hidden=true;
    dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','保存当前窗景');
    dialog.innerHTML='<div class="save-card"><button type="button" class="save-close" aria-label="返回画窗">×</button><img alt="刚刚保存的窗景，含雾气和笔迹"><p></p><button type="button" class="save-action">保存图片</button></div>';
    document.body.appendChild(dialog);
    photo=dialog.querySelector('img');save=dialog.querySelector('.save-action');close=dialog.querySelector('.save-close');note=dialog.querySelector('p');
    close.addEventListener('click',dismiss);
    dialog.addEventListener('click',function(e){if(e.target===dialog)dismiss();});
    dialog.addEventListener('keydown',function(e){
      if(e.key==='Escape'){e.preventDefault();dismiss();}
      if(e.key==='Tab'){
        if(e.shiftKey&&document.activeElement===close){e.preventDefault();save.focus();}
        else if(!e.shiftKey&&document.activeElement===save){e.preventDefault();close.focus();}
      }
    });
    save.addEventListener('click',function(){
      if(shareFile){
        save.disabled=true;
        try {
          navigator.share({files:[shareFile]}).then(function(){save.disabled=false;},function(err){
            save.disabled=false;
            if(!err||err.name!=='AbortError'){
              shareFile=null;note.textContent='长按图片保存，或下载到文件';save.textContent='下载图片';
            }
          });
        } catch(e){save.disabled=false;shareFile=null;note.textContent='长按图片保存，或下载到文件';save.textContent='下载图片';}
      } else {download();note.textContent='已请求下载，也可以长按图片保存';}
    });
  }
  function present() {
    createDialog();shareFile=null;
    try {
      var file=new File([blob],filename,{type:'image/png'});
      if(navigator.canShare&&navigator.share&&navigator.canShare({files:[file]}))shareFile=file;
    } catch(e){}
    photo.src=url;save.disabled=false;save.textContent=shareFile?'保存 / 分享':'下载图片';
    note.textContent=shareFile?'长按图片保存，或打开系统分享':'长按图片保存，或下载到文件';
    dialog.hidden=false;
    document.getElementById('controls').setAttribute('aria-hidden','true');
    document.getElementById('stage').setAttribute('aria-hidden','true');
    close.focus();
  }
  function capture(makePicture) {
    if(busy)return;
    busy=true;owner.setAttribute('aria-busy','true');
    function done(){busy=false;owner.removeAttribute('aria-busy');}
    try {
      var canvas=makePicture();
      canvas.toBlob(function(result){
        done();
        if(!result){notify('图片未能生成，请再试一次');return;}
        revoke();blob=result;url=URL.createObjectURL(blob);
        filename='mistpane-'+new Date().toISOString().replace(/[:.]/g,'-')+'.png';
        if(('ontouchstart' in window)||(navigator.maxTouchPoints>0))present();
        else {
          download();notify('已生成图片并开始下载');
          var thisUrl=url;setTimeout(function(){if(url===thisUrl)revoke();},60000);
        }
      },'image/png');
    } catch(e){done();notify('图片还未准备好，请稍后再试');}
  }
  window.MIST_SAVE={
    bind:function(button,makePicture,showToast){owner=button;notify=showToast;button.addEventListener('click',function(){capture(makePicture);});},
    isOpen:function(){return !!dialog&&!dialog.hidden;}
  };
})();
