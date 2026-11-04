/* Official miniTool adapter: no SDK, networking or browser downloads. */
(function () {
  'use strict';
  var P={version:0,insets:{top:64,bottom:0,left:0,right:0},revision:0};
  P.api=function(){return window.xhs&&window.xhs.miniTool;};
  P.call=function(name,args){return new Promise(function(resolve,reject){
    var api=P.api(),done=false;
    function finish(fn,value){if(done)return;done=true;clearTimeout(timer);fn(value);}
    var timer=setTimeout(function(){finish(reject,new Error('操作等待超时，请重试'));},20000);
    if(!api||typeof api[name]!=='function'){finish(reject,new Error('请在支持此功能的小红书版本中打开'));return;}
    var opt=args||{};opt.success=function(v){finish(resolve,v);};opt.fail=function(e){finish(reject,e);};
    try {api[name](opt);}catch(e){finish(reject,e);}
  });};
  function version(options){var e=options&&options.miniToolEnv;return Math.floor((Number(e&&e.buildVersion)||0)/1000);}
  function cssInset(side){
    var r=getComputedStyle(document.documentElement),b=getComputedStyle(document.body);
    var v=Math.max(parseFloat(r.getPropertyValue('--safe-area-inset-'+side))||0,parseFloat(b.getPropertyValue('--safe-area-inset-'+side))||0);
    var probe=document.createElement('div');probe.style.cssText='position:absolute;visibility:hidden;padding-top:0';probe.style.paddingTop='env(safe-area-inset-'+side+')';document.body.appendChild(probe);
    v=Math.max(v,parseFloat(getComputedStyle(probe).paddingTop)||0);document.body.removeChild(probe);return v;
  }
  P.refresh=function(){
    var api=P.api(),task=P.version>=9490&&api&&typeof api.getWindowInfo==='function'?P.call('getWindowInfo'):Promise.resolve(null);
    return task.catch(function(){return null;}).then(function(info){
      var i={top:Math.max(64,cssInset('top')+12),bottom:cssInset('bottom'),left:cssInset('left'),right:cssInset('right')};
      if(info&&info.safeArea){var s=info.safeArea;
        i.top=Math.max(s.top+12,12);i.bottom=Math.max(i.bottom,(info.windowHeight||window.innerHeight)-s.bottom,0);
        i.left=Math.max(i.left,s.left||0);i.right=Math.max(i.right,(info.windowWidth||window.innerWidth)-s.right,0);
        var buttons=info.menuButtons||{};['back','me','share'].forEach(function(k){if(buttons[k])i.top=Math.max(i.top,buttons[k].bottom+12);});
      }
      P.insets=i;P.revision++;
      var s=document.documentElement.style;
      ['top','bottom','left','right'].forEach(function(k){s.setProperty('--mist-safe-'+k,i[k]+'px');});
      if(typeof P.onLayout==='function')P.onLayout();
    });
  };
  P.version=version(window.xhs&&window.xhs.launchOptions);
  P.ready=(P.version?Promise.resolve():P.api()&&typeof P.api().getLaunchOptions==='function'?P.call('getLaunchOptions').then(function(o){P.version=version(o);}):Promise.resolve()).catch(function(){}).then(P.refresh);
  var resizeTimer;window.addEventListener('resize',function(){clearTimeout(resizeTimer);resizeTimer=setTimeout(P.refresh,180);});
  window.MIST_PLATFORM=P;
})();
