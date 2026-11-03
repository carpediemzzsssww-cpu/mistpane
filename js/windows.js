/* Static, resolution-independent cabin interiors. Aperture geometry is shared
   by framing, photo composition, and input hit testing. No extra GL textures. */
(function () {
  'use strict';
  var hit = document.createElement('canvas').getContext('2d');
  var grain = null;

  function geometry(type, W, H) {
    var w = W, h = H, cy = H * 0.44;
    if (type === 1) { w = Math.min(W * 0.86, H * 0.69 * 1.48); h = w / 1.48; }
    if (type === 2) { h = Math.min(H * 0.72, W * 0.77 / 0.76); w = h * 0.76; }
    if (type === 3) { w = Math.min(W * 0.79, H * 0.67 * 1.17); h = w / 1.17; }
    if (type === 4) { h = Math.min(H * 0.70, W * 0.72 / 0.64); w = h * 0.64; }
    var r = { x: (W - w) / 2, y: type ? cy - h / 2 : 0, w: w, h: h, type: type };
    r.path = path(r, 0);
    return r;
  }

  function path(r, expand) {
    var p = new Path2D(), x = r.x - expand, y = r.y - expand;
    var w = r.w + 2 * expand, h = r.h + 2 * expand;
    function M(a, b) { p.moveTo(x + a * w, y + b * h); }
    function L(a, b) { p.lineTo(x + a * w, y + b * h); }
    function C(a,b,c,d,e,f) { p.bezierCurveTo(x+a*w,y+b*h,x+c*w,y+d*h,x+e*w,y+f*h); }
    if (r.type === 1) {
      M(.075,.025); C(.025,.03,.006,.085,.004,.19);
      L(.008,.963); C(.009,.993,.025,1,.075,1);
      L(.985,.987); C(1,.986,1,.966,1,.93);
      L(.993,.365); C(.981,.245,.878,.070,.745,.030);
      C(.625,-.002,.28,.008,.075,.025);
    } else if (r.type === 4) {
      M(.5,0); C(.23,0,.085,.038,.045,.20);
      C(-.012,.43,.002,.77,.105,.91);
      C(.19,1.025,.80,1.025,.895,.91);
      C(.998,.77,1.012,.43,.955,.20);
      C(.915,.038,.77,0,.5,0);
    } else {
      var rx = w * (r.type === 2 ? .205 : .065), ry = rx;
      p.moveTo(x+rx,y); p.lineTo(x+w-rx,y);
      p.bezierCurveTo(x+w-rx*.30,y,x+w,y+ry*.30,x+w,y+ry);
      p.lineTo(x+w,y+h-ry);
      p.bezierCurveTo(x+w,y+h-ry*.30,x+w-rx*.30,y+h,x+w-rx,y+h);
      p.lineTo(x+rx,y+h);
      p.bezierCurveTo(x+rx*.30,y+h,x,y+h-ry*.30,x,y+h-ry);
      p.lineTo(x,y+ry);
      p.bezierCurveTo(x,y+ry*.30,x+rx*.30,y,x+rx,y);
    }
    p.closePath();
    return p;
  }

  function gradient(c, r, stops, horizontal) {
    var g = horizontal ? c.createLinearGradient(r.x-r.w*.1,r.y,r.x+r.w*1.1,r.y+r.h*.45) :
      c.createLinearGradient(r.x-r.w*.1,r.y-r.h*.1,r.x+r.w*.65,r.y+r.h*1.1);
    for (var i=0; i<stops.length; i++) g.addColorStop(stops[i][0],stops[i][1]);
    return g;
  }

  function layer(c,r,e,stops,shadow) {
    c.save();
    if (shadow) { c.shadowColor='rgba(0,0,0,.75)'; c.shadowBlur=shadow; c.shadowOffsetY=shadow*.35; }
    c.fillStyle=typeof stops==='string' ? stops : gradient(c,r,stops);
    c.fill(path(r,e)); c.restore();
  }

  function line(c,r,e,color,width) {
    c.strokeStyle=color; c.lineWidth=width; c.stroke(path(r,e));
  }

  function texture(c,W,H) {
    if (!grain) {
      grain=document.createElement('canvas'); grain.width=grain.height=128;
      var g=grain.getContext('2d'), im=g.createImageData(128,128), s=9401;
      for (var i=0; i<im.data.length; i+=4) {
        s=(s*1664525+1013904223)>>>0;
        var v=s>>>24;
        im.data[i]=im.data[i+1]=im.data[i+2]=v;
        im.data[i+3]=9;
      }
      g.putImageData(im,0,0);
    }
    c.fillStyle=c.createPattern(grain,'repeat'); c.fillRect(0,0,W,H);
  }

  function screw(c,x,y,s) {
    var g=c.createLinearGradient(x-s,y-s,x+s,y+s);
    g.addColorStop(0,'#ccd0c9'); g.addColorStop(.40,'#777d76'); g.addColorStop(1,'#252c2a');
    c.fillStyle='rgba(0,0,0,.60)'; c.beginPath(); c.arc(x,y+s*.18,s*1.12,0,Math.PI*2); c.fill();
    c.fillStyle=g; c.beginPath(); c.arc(x,y,s,0,Math.PI*2); c.fill();
    c.strokeStyle='rgba(19,23,22,.8)'; c.lineWidth=s*.32;
    c.beginPath(); c.moveTo(x-s*.48,y+s*.15); c.lineTo(x+s*.48,y-s*.15); c.stroke();
  }

  function draw(canvas, type, W, H, dpr) {
    canvas.width=Math.round(W*dpr); canvas.height=Math.round(H*dpr);
    var c=canvas.getContext('2d'); c.setTransform(dpr,0,0,dpr,0,0);
    var r=geometry(type,W,H), u=Math.min(r.w,r.h), t=u*.054;
    if (!type) return r;

    // Ambient light on the wall; every mode has its own material and palette.
    var wall=c.createRadialGradient(W*.43,H*.38,u*.15,W*.52,H*.48,Math.max(W,H)*.72);
    var colors=type===1 ? ['#4b4939','#25261f','#080b0c'] :
      type===2 ? ['#726345','#494330','#181b17'] :
      type===3 ? ['#293435','#131d20','#070c0e'] : ['#687177','#343e46','#151f28'];
    wall.addColorStop(0,colors[0]); wall.addColorStop(.50,colors[1]); wall.addColorStop(1,colors[2]);
    c.fillStyle=wall; c.fillRect(0,0,W,H);

    if (type===1) {
      // Cloth-covered pillars taper into the black rubber weather seal.
      layer(c,r,t*1.95,[[0,'#696854'],[.25,'#555442'],[.55,'#33382f'],[1,'#1c211e']],t*.9);
      line(c,r,t*1.68,'rgba(12,16,13,.35)',1.3);
      layer(c,r,t*.82,[[0,'#121715'],[.35,'#252b27'],[.65,'#0d1211'],[1,'#080c0d']]);
      line(c,r,t*.70,'rgba(124,135,117,.22)',1.3);
      layer(c,r,t*.34,[[0,'#030808'],[.45,'#141d19'],[1,'#050a0b']]);
      line(c,r,t*.12,'rgba(171,185,153,.27)',1);
      // A door panel, with a padded upper rail and a restrained stitched seam.
      var y=r.y+r.h+t*.38;
      var door=c.createLinearGradient(0,y,0,H); door.addColorStop(0,'#232924');door.addColorStop(.12,'#101717');door.addColorStop(1,'#080e10');
      c.fillStyle=door; c.beginPath();c.moveTo(0,y+H*.025);c.bezierCurveTo(W*.30,y-H*.02,W*.69,y+H*.01,W,y-H*.015);c.lineTo(W,H);c.lineTo(0,H);c.fill();
      c.strokeStyle='rgba(144,152,126,.16)';c.lineWidth=1;c.beginPath();c.moveTo(0,y+5);c.bezierCurveTo(W*.28,y-13,W*.75,y+3,W,y-6);c.stroke();
    } else if (type===2) {
      // Painted carriage wall and a substantial, slightly worn rubber gasket.
      c.fillStyle='rgba(0,0,0,.22)';c.fillRect(r.x-r.w*.23,0,2,H);
      c.fillStyle='rgba(221,202,154,.07)';c.fillRect(r.x-r.w*.23+2,0,1,H);
      layer(c,r,t*1.85,[[0,'#555746'],[.22,'#34392f'],[.55,'#171e1a'],[1,'#171c18']],t*.9);
      layer(c,r,t*1.49,[[0,'#111813'],[.22,'#283027'],[.52,'#0c1412'],[1,'#121917']]);
      line(c,r,t*1.28,'rgba(144,155,117,.14)',1.4);
      layer(c,r,t*.78,[[0,'#222d25'],[.23,'#3c4633'],[.50,'#222d26'],[1,'#0a1514']]);
      line(c,r,t*.49,'rgba(164,172,123,.25)',1);
      layer(c,r,t*.24,'#071312');
    } else if (type===3) {
      // A metal ferry window: broad stamped trim, warm oxidised inner flange.
      layer(c,r,t*1.93,[[0,'#171d20'],[.23,'#363f41'],[.7,'#161e21'],[1,'#10191c']],t*1.1);
      layer(c,r,t*1.70,[[0,'#c2c4b5'],[.15,'#737e7a'],[.32,'#aab3ab'],[.52,'#697772'],[.72,'#c1c6b6'],[1,'#53615e']]);
      line(c,r,t*1.62,'rgba(221,227,213,.65)',1);
      layer(c,r,t*1.18,[[0,'#4c5b54'],[.26,'#a6aa8d'],[.52,'#b4b49a'],[.76,'#767f68'],[1,'#b3b699']]);
      line(c,r,t*1.10,'rgba(22,32,28,.55)',1.3);
      layer(c,r,t*.49,[[0,'#142321'],[.45,'#24352e'],[1,'#071714']]);
      line(c,r,t*.20,'rgba(193,202,179,.34)',1);
      var s=Math.max(1.15,u*.0054), off=t*.83;
      for(var k=0;k<5;k++) {
        var q=.15+k*.175;
        screw(c,r.x+r.w*q,r.y-off,s);screw(c,r.x+r.w*q,r.y+r.h+off,s);
      }
      for(var j=0;j<3;j++) {
        var qy=.22+j*.28;
        screw(c,r.x-off,r.y+r.h*qy,s);screw(c,r.x+r.w+off,r.y+r.h*qy,s);
      }
    } else {
      // An injection-moulded aircraft reveal: a deep well, nested lips and seams.
      layer(c,r,t*2.7,'#202b32',t*1.2);
      layer(c,r,t*2.48,[[0,'#889398'],[.20,'#6c797f'],[.46,'#48575f'],[.72,'#77858b'],[1,'#3d4c55']]);
      line(c,r,t*2.36,'rgba(24,37,45,.65)',1.6);
      layer(c,r,t*2.15,[[0,'#b5bfc0'],[.25,'#9ba9ae'],[.55,'#8d9da4'],[1,'#899ba2']]);
      line(c,r,t*2.05,'rgba(230,237,229,.20)',1.2);
      layer(c,r,t*1.56,[[0,'#b1bfc1'],[.28,'#93a6ac'],[.5,'#81979f'],[.80,'#9fb2b5'],[1,'#91a7ae']]);
      layer(c,r,t*1.02,[[0,'#c3cccc'],[.27,'#b0bec1'],[.58,'#a4b7be'],[1,'#a8bfc3']]);
      line(c,r,t*.94,'rgba(241,246,229,.25)',1.1);
      layer(c,r,t*.52,[[0,'#405761'],[.33,'#6d8792'],[.70,'#a7babf'],[1,'#6c8793']]);
      layer(c,r,t*.19,[[0,'#405b68'],[.4,'#68838e'],[1,'#859da5']]);
    }

    texture(c,W,H);
    // Punch the actual aperture after finishing the opaque material.
    c.globalCompositeOperation='destination-out';c.fillStyle='#000';c.fill(r.path);
    c.globalCompositeOperation='source-over';
    c.save();c.clip(r.path);
    c.strokeStyle='rgba(1,8,11,.56)';c.lineWidth=t*.50;c.shadowColor='rgba(0,8,12,.45)';c.shadowBlur=t*.55;c.stroke(r.path);
    c.shadowBlur=0;
    var shade=c.createLinearGradient(0,r.y,0,r.y+Math.min(r.h*.17,65));
    shade.addColorStop(0,'rgba(3,12,15,.28)');shade.addColorStop(1,'rgba(3,12,15,0)');
    c.fillStyle=shade;c.fillRect(r.x,r.y,r.w,r.h);
    c.restore();

    if(type===4) {
      // The retracted shade sits in front of the glass at the crown of the well.
      var sh=new Path2D();
      sh.moveTo(r.x+r.w*.08,r.y+r.h*.044);
      sh.bezierCurveTo(r.x+r.w*.20,r.y-r.h*.026,r.x+r.w*.8,r.y-r.h*.026,r.x+r.w*.92,r.y+r.h*.044);
      sh.bezierCurveTo(r.x+r.w*.87,r.y+r.h*.093,r.x+r.w*.13,r.y+r.h*.093,r.x+r.w*.08,r.y+r.h*.044);
      c.save();c.shadowColor='rgba(0,5,12,.65)';c.shadowBlur=t*.55;c.shadowOffsetY=t*.22;
      c.fillStyle=gradient(c,{x:r.x,y:r.y-r.h*.01,w:r.w,h:r.h*.11},[[0,'#3e515b'],[.37,'#2b414e'],[.72,'#203540'],[1,'#3c5561']]);c.fill(sh);c.restore();
      c.strokeStyle='rgba(201,216,212,.18)';c.lineWidth=1;c.stroke(sh);
    }
    return r;
  }

  function contains(r,x,y) {
    if(!r || !r.type) return true;
    if(r.type===4 && y<r.y+r.h*.083) return false;
    return hit.isPointInPath(r.path,x,y);
  }
  window.MIST_WINDOWS={geometry:geometry,draw:draw,contains:contains};
})();
