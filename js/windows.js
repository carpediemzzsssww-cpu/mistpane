/* Original 2.5D cabin surfaces: a continuous moulded profile lit by its normals.
   Static frame rasterises only on resize; shade motion uses a small cached canvas.
   Geometry is shared by the photograph, frame, shade and fog hit testing. */
(function () {
  'use strict';
  var hit = document.createElement('canvas').getContext('2d');
  var active = null, frameEl, shadeEl, shadeCtx, handle, ambient, shadePaint;
  var position = 0, velocity = 0, target = null, dragging = false, pointer = null;
  var startY = 0, startPosition = 0, lastY = 0, lastTime = 0, moved = 0;
  var lastPaint = -99, light = 1, ready = false;
  var layoutW = -1, layoutH = -1, safeInset = 0;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function clamp(v,a,b) { return Math.max(a,Math.min(b,v)); }
  function mix(a,b,t) { return a+(b-a)*t; }
  function sign(v) { return v < 0 ? -1 : 1; }

  function geometry(type,W,H) {
    var phone = W < 650, landscape = H < 500 && W > H;
    if (W !== layoutW || H !== layoutH) {
      layoutW = W; layoutH = H; var controls = document.getElementById('controls');
      safeInset = controls ? Math.max(0, (parseFloat(getComputedStyle(controls).bottom) || 18) - 18) : 0;
    }
    var safeBottom = safeInset;
    var viewW = landscape ? Math.max(180, W - 194) : W;
    var top = landscape ? 20 : 42;
    var bottom = landscape ? 20 : 172 + safeBottom;
    var avail = Math.max(160, H - top - bottom), w = W, h = H;
    if(type===1) { w=Math.min(viewW*.83,avail*1.45); h=Math.min(avail*.83,w/(phone?.83:1.45)); }
    if(type===2) { h=Math.min(avail*.83,viewW*.79/.78); w=h*.78; }
    if(type===3) { w=Math.min(viewW*.80,avail*1.10); h=Math.min(avail*.83,w/(phone?.85:1.10)); }
    if(type===4) { h=Math.min(avail*.83,viewW*.72/.70); w=h*.70; }
    var cy=top+avail*.50;
    var r={x:type?(viewW-w)/2:0,y:type?cy-h/2:0,w:w,h:h,type:type,W:W,H:H,n:type===4?3.15:type===2?5.0:type===3?7:5};
    r.rim=w*(type===4?.145:type===2?.09:type===3?.065:.07);
    r.path=path(r,0);
    return r;
  }
  function path(r,e) {
    var p=new Path2D(), a=r.w/2+e,b=r.h/2+e,cx=r.x+r.w/2,cy=r.y+r.h/2;
    for(var i=0;i<=256;i++) {
      var t=i*Math.PI*2/256, co=Math.cos(t),si=Math.sin(t);
      var x=cx+a*sign(co)*Math.pow(Math.abs(co),2/r.n);
      var y=cy+b*sign(si)*Math.pow(Math.abs(si),2/r.n);
      if(i===0)p.moveTo(x,y);else p.lineTo(x,y);
    }
    p.closePath();return p;
  }
  // Height profile, in units of rim width. A recessed reveal with one rolled lip.
  var profile=[[0,-.35],[.045,-.30],[.08,-.30],[.13,-.10],[.19,-.08],[.25,-.12],
    [.64,.26],[.78,.30],[.91,.18],[1,0]];
  function surface(t) {
    for(var i=1;i<profile.length;i++)if(t<=profile[i][0]) {
      var a=profile[i-1],b=profile[i],u=clamp((t-a[0])/(b[0]-a[0]),0,1);
      return {z:mix(a[1],b[1],u*u*(3-2*u)),s:(b[1]-a[1])*6*u*(1-u)/(b[0]-a[0])};
    }
    return {z:0,s:0};
  }
  function paintFrame(c,r,dpr) {
    var rim=r.rim, pad=rim+3, x0=Math.floor(r.x-pad),y0=Math.floor(r.y-pad);
    var pw=Math.ceil((r.w+pad*2)*dpr),ph=Math.ceil((r.h+pad*2)*dpr);
    var cv=document.createElement('canvas');cv.width=pw;cv.height=ph;
    var cc=cv.getContext('2d'),im=cc.createImageData(pw,ph),data=im.data;
    var a=r.w/2,b=r.h/2,n=r.n;
    var base=r.type===4?[232,229,222]:r.type===2?[183,182,174]:r.type===3?[159,169,171]:[63,66,64];
    for(var y=0;y<ph;y++)for(var x=0;x<pw;x++) {
      var px=x0+(x+.5)/dpr-r.x-a,py=y0+(y+.5)/dpr-r.y-b;
      var ax=Math.abs(px)/a,ay=Math.abs(py)/b;
      var k=Math.pow(Math.pow(ax,n)+Math.pow(ay,n),1/n);
      if(k<.985||k>2)continue;
      var gx=Math.pow(ax,n-1)/a,gy=Math.pow(ay,n-1)/b;
      var len=Math.sqrt(gx*gx+gy*gy)||1;
      // First-order signed distance to a superellipse; exact at the boundary.
      var d=(k-1)*Math.pow(k,n-1)/len;
      if(d<-.8||d>rim+1)continue;
      var t=clamp(d/rim,0,1),s=surface(t),nx=-s.s*gx/len*sign(px),ny=-s.s*gy/len*sign(py);
      var inv=1/Math.sqrt(nx*nx+ny*ny+1);
      var diffuse=Math.max(0,(nx*-.36+ny*-.55+1*.76)*inv);
      var lighting=.73+.30*diffuse;
      // Recess occlusion, a fine gasket and a single parting seam.
      lighting-=.15*Math.exp(-t*11);
      lighting-=.34*Math.exp(-Math.pow((t-.032)/.018,2));
      lighting-=.16*Math.exp(-Math.pow((t-.225)/.012,2));
      lighting+=.055*Math.exp(-Math.pow((t-.275)/.019,2));
      lighting-=.14*Math.exp(-Math.pow((t-.987)/.013,2));
      var grain=((Math.sin(x*12.9898+y*78.233)*43758.5453)%1)*.7;
      var i=(y*pw+x)*4;
      for(var j=0;j<3;j++) data[i+j]=clamp(base[j]*lighting+grain+(j===2?2:0)*Math.exp(-t*4),0,255);
      data[i+3]=255*clamp((d+.8)*dpr,0,1)*clamp((rim+1-d)*dpr,0,1);
    }
    cc.putImageData(im,0,0);c.drawImage(cv,x0,y0,pw/dpr,ph/dpr);
  }
  function draw(canvas,type,W,H,dpr) {
    frameEl=canvas;
    canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);
    var c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);
    active=geometry(type,W,H);var r=active;
    setup();cancel();
    document.body.setAttribute('data-window',String(type));
    shadeEl.hidden=handle.hidden=type!==4;
    position=clamp(position,0,1);
    if(!type){updateLight();return r;}
    var wall=c.createRadialGradient(W*.48,H*.35,0,W*.5,H*.5,Math.max(W,H)*.85);
    var colors=type===4?['#f6f4ef','#e5e3dd','#c8c8c2']:type===2?['#e3e0d7','#cbc8bd','#afafa5']:type===3?['#303a3d','#20292c','#141b20']:['#444843','#2c302e','#1e2423'];
    wall.addColorStop(0,colors[0]);wall.addColorStop(.6,colors[1]);wall.addColorStop(1,colors[2]);
    c.fillStyle=wall;c.fillRect(0,0,W,H);
    c.save();c.shadowColor=type===4?'rgba(45,39,31,.26)':'rgba(0,0,0,.42)';
    c.shadowBlur=r.rim*.50;c.shadowOffsetY=r.rim*.17;c.fillStyle=colors[1];c.fill(path(r,r.rim*.98));c.restore();
    // The raster uses the same implicit surface as the aperture.
    paintFrame(c,r,dpr);
    c.globalCompositeOperation='destination-out';c.fill(r.path);c.globalCompositeOperation='source-over';
    c.save();c.clip(r.path);c.lineWidth=Math.max(3,r.w*.012);c.strokeStyle='rgba(25,29,27,.42)';
    c.shadowColor='rgba(21,26,25,.46)';c.shadowBlur=r.w*.035;c.stroke(r.path);c.restore();
    if(type===4) makeShade(r,dpr);
    lastPaint=-99;updateLight();paintShade();
    return r;
  }
  function makeShade(r,dpr) {
    // Work in aperture coordinates. Canvas is clipped to the actual glass opening.
    shadeEl.width=Math.ceil(r.w*dpr);shadeEl.height=Math.ceil(r.h*dpr);
    shadeEl.style.left=r.x+'px';shadeEl.style.top=r.y+'px';shadeEl.style.width=r.w+'px';shadeEl.style.height=r.h+'px';
    shadeCtx=shadeEl.getContext('2d');
    shadePaint=document.createElement('canvas');shadePaint.width=shadeEl.width;shadePaint.height=Math.ceil((r.h+32)*dpr);
    var c=shadePaint.getContext('2d');c.scale(dpr,dpr);
    var g=c.createLinearGradient(0,0,r.w,0);
    g.addColorStop(0,'#a8a69e');g.addColorStop(.08,'#d4d1c8');g.addColorStop(.3,'#e4e0d7');g.addColorStop(.7,'#e3dfd5');g.addColorStop(.95,'#c7c5bc');g.addColorStop(1,'#a09f98');
    c.fillStyle=g;c.fillRect(0,0,r.w,r.h+32);
    var v=c.createLinearGradient(0,0,0,r.h+32);v.addColorStop(0,'rgba(71,66,56,.17)');v.addColorStop(.8,'rgba(245,242,233,.03)');v.addColorStop(1,'rgba(79,74,61,.12)');
    c.fillStyle=v;c.fillRect(0,0,r.w,r.h+32);
    c.strokeStyle='rgba(70,65,55,.022)';c.lineWidth=.5;
    for(var y=0;y<r.h+32;y+=2.5){c.beginPath();c.moveTo(0,y);c.lineTo(r.w,y);c.stroke();}
  }
  function edge() { return active ? 36+(active.h-28)*position : 0; }
  function paintShade() {
    if(!active||active.type!==4||!shadeCtx)return;
    if(Math.abs(lastPaint-position)<.0001)return;
    lastPaint=position;
    var r=active,c=shadeCtx,dpr=shadeEl.width/r.w, e=edge();
    c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,r.w,r.h);
    c.save();c.translate(-r.x,-r.y);c.clip(r.path);c.translate(r.x,r.y);
    var bottom=new Path2D();bottom.moveTo(-2,-r.h);bottom.lineTo(r.w+2,-r.h);bottom.lineTo(r.w+2,e-9);
    bottom.bezierCurveTo(r.w*.72,e+4,r.w*.28,e+4,-2,e-9);bottom.closePath();
    c.save();c.shadowColor='rgba(13,20,23,.42)';c.shadowBlur=15;c.shadowOffsetY=8;c.fillStyle='#c9c6bd';c.fill(bottom);c.restore();
    c.save();c.clip(bottom);c.drawImage(shadePaint,0,e-r.h-28,r.w,r.h+32);c.restore();
    c.strokeStyle='rgba(255,255,250,.6)';c.lineWidth=1;c.stroke(bottom);
    c.restore();
    handle.style.left=(r.x+r.w*.5-44)+'px';
    handle.style.top=(r.y+Math.min(r.h-27,e-13)-22)+'px';
    handle.setAttribute('aria-valuenow',String(Math.round((1-clamp(position,0,1))*100)));
    handle.setAttribute('aria-valuetext','打开 '+Math.round((1-clamp(position,0,1))*100)+'%');
  }
  function updateLight() {
    var plane=active&&active.type===4;
    light=plane?Math.pow(1-clamp(position,0,1),.72):1;
    if(plane) {
      // Ambient cabin fades continuously, with enough residual light to find the grip.
      frameEl.style.filter='brightness('+(.20+.80*light).toFixed(4)+')';
      shadeEl.style.filter=handle.style.filter='brightness('+(.18+.82*light).toFixed(4)+')';
      ambient.style.opacity=((1-light)*.13).toFixed(4);
      document.body.style.setProperty('--cabin-light',light.toFixed(4));
    } else {frameEl.style.filter='';ambient.style.opacity='0';}
    document.body.classList.toggle('cabin-dark',plane&&light<.4);
  }
  function cancel() {dragging=false;pointer=null;velocity=0;target=null;if(handle)handle.classList.remove('dragging');}
  function tick(dt) {
    if(!active||active.type!==4)return;
    if(!dragging) {
      if(target!==null) {
        var steps=4,sub=dt/steps;
        for(var i=0;i<steps;i++){velocity+=((target-position)*190-velocity*23)*sub;position+=velocity*sub;}
        if(Math.abs(target-position)<.0002&&Math.abs(velocity)<.002){position=target;velocity=0;target=null;}
      } else if(Math.abs(velocity)>.002) {
        velocity*=Math.exp(-9*dt);position+=velocity*dt;
        if(position<0||position>1)target=clamp(position,0,1);
      }
    }
    if(Math.abs(lastPaint-position)>.0001){updateLight();paintShade();}
  }
  function down(y,id) {
    if(!active||active.type!==4||dragging)return;
    dragging=true;pointer=id;startY=lastY=y;startPosition=position;lastTime=performance.now();moved=0;velocity=0;target=null;
    handle.classList.add('dragging');document.getElementById('hint').style.opacity='0';
  }
  function move(y) {
    if(!dragging)return;
    var now=performance.now(),travel=active.h-28,raw=startPosition+(y-startY)/travel;
    position=raw<0?raw*.12:raw>1?1+(raw-1)*.12:raw;
    var v=(y-lastY)/travel/Math.max(.008,(now-lastTime)/1000);
    velocity=mix(velocity,clamp(v,-3,3),.6);lastTime=now;lastY=y;moved=Math.max(moved,Math.abs(y-startY));
    updateLight();paintShade();
  }
  function up(cancelled) {
    if(!dragging)return;dragging=false;pointer=null;handle.classList.remove('dragging');
    if(cancelled){velocity=0;target=clamp(position,0,1);return;}
    if(moved<5){target=position>.5?0:1;velocity=0;if(reduced){position=target;target=null;updateLight();paintShade();}}
    else {
      if(performance.now()-lastTime>90)velocity=0;
      if(reduced)velocity=0;
      if(position<.035)target=0;else if(position>.965)target=1;
    }
  }
  function covered(x,y) {
    return active && active.type===4 && y<active.y+edge() && hit.isPointInPath(active.path,x,y);
  }
  function setup() {
    if(ready)return;ready=true;
    shadeEl=document.getElementById('windowShade');handle=document.getElementById('shadeHandle');ambient=document.getElementById('cabinAmbient');
    var stage=document.getElementById('stage');
    // Capture shade gestures before the glass receives them. Its entire solid surface is draggable.
    if(window.PointerEvent) {
      stage.addEventListener('pointerdown',function(e){
        if(e.target===handle||handle.contains(e.target)||e.button>0||!covered(e.clientX,e.clientY))return;
        if(dragging)return;e.stopImmediatePropagation();e.preventDefault();down(e.clientY,e.pointerId);stage.setPointerCapture(e.pointerId);
      },true);
      stage.addEventListener('pointermove',function(e){if(dragging&&e.pointerId===pointer){e.stopImmediatePropagation();move(e.clientY);}},true);
      stage.addEventListener('pointerup',function(e){if(dragging&&e.pointerId===pointer){e.stopImmediatePropagation();up(false);}},true);
      stage.addEventListener('pointercancel',function(e){if(dragging&&e.pointerId===pointer){e.stopImmediatePropagation();up(true);}},true);
      handle.addEventListener('pointerdown',function(e){if(e.button>0)return;e.stopPropagation();e.preventDefault();down(e.clientY,e.pointerId);handle.setPointerCapture(e.pointerId);});
      handle.addEventListener('pointermove',function(e){e.stopPropagation();if(e.pointerId===pointer)move(e.clientY);});
      handle.addEventListener('pointerup',function(e){e.stopPropagation();if(e.pointerId===pointer)up(false);});
      handle.addEventListener('pointercancel',function(e){e.stopPropagation();up(true);});
      handle.addEventListener('lostpointercapture',function(){up(true);});
    } else {
      stage.addEventListener('touchstart',function(e){if(e.touches.length!==1)return;var t=e.touches[0];if(e.target===handle||handle.contains(e.target)||!covered(t.clientX,t.clientY))return;e.stopImmediatePropagation();e.preventDefault();down(t.clientY,'touch');},{capture:true,passive:false});
      stage.addEventListener('touchmove',function(e){if(dragging&&e.touches.length===1){e.stopImmediatePropagation();e.preventDefault();move(e.touches[0].clientY);}},{capture:true,passive:false});
      stage.addEventListener('touchend',function(e){if(dragging){e.stopImmediatePropagation();up(false);}},true);
      stage.addEventListener('touchcancel',function(){up(true);},true);
      stage.addEventListener('mousedown',function(e){if(e.button||e.target===handle||handle.contains(e.target)||!covered(e.clientX,e.clientY))return;e.stopImmediatePropagation();e.preventDefault();down(e.clientY,'mouse');},true);
      handle.addEventListener('touchstart',function(e){e.stopPropagation();e.preventDefault();if(e.touches.length===1)down(e.touches[0].clientY,'touch');},{passive:false});
      handle.addEventListener('touchmove',function(e){e.stopPropagation();e.preventDefault();if(e.touches.length===1)move(e.touches[0].clientY);},{passive:false});
      handle.addEventListener('touchend',function(e){e.stopPropagation();up(false);});handle.addEventListener('touchcancel',function(){up(true);});
      handle.addEventListener('mousedown',function(e){e.stopPropagation();e.preventDefault();down(e.clientY,'mouse');});
      window.addEventListener('mousemove',function(e){if(pointer==='mouse')move(e.clientY);});window.addEventListener('mouseup',function(){up(false);});
    }
    handle.addEventListener('keydown',function(e){
      var k=e.key;if(['ArrowUp','ArrowDown','Home','End',' ','Enter'].indexOf(k)<0)return;
      e.preventDefault();e.stopPropagation();velocity=0;
      target=k==='Home'?0:k==='End'?1:k==='ArrowUp'?clamp(position-.10,0,1):k==='ArrowDown'?clamp(position+.10,0,1):position>.5?0:1;
      if(reduced){position=target;target=null;updateLight();paintShade();}
    });
    window.addEventListener('blur',function(){up(true);});
    document.addEventListener('visibilitychange',function(){if(document.hidden)up(true);});
  }
  function contains(r,x,y) {
    if(!r||!r.type)return true;
    if(r.type===4&&y<r.y+edge()+10)return false;
    return hit.isPointInPath(r.path,x,y);
  }
  window.MIST_WINDOWS={geometry:geometry,draw:draw,contains:contains,tick:tick,
    breathPoint:function(r){
      if(!r||r.type!==4)return {x:r.x+r.w*.5,y:r.y+r.h*.5};
      var top=r.y+edge()+12;if(top>r.y+r.h-35)return null;
      return {x:r.x+r.w*.5,y:mix(top,r.y+r.h,.45)};
    },
    state:function(){return {closed:clamp(position,0,1),velocity:velocity,dragging:dragging,light:light,reduced:!!reduced};}};
})();
