(function(){
  var EXPORT_W = 1280;
  var EXPORT_H = 720;
  var PPT_W = 13.333333;
  var PPT_H = 7.5;
  var EXPORT_SCALE = 3; // 3840×2160 screenshots.
  var btn = document.getElementById('btn-export-pptx');
  var status = document.getElementById('export-status');
  var choiceBackdrop = document.getElementById('export-choice-backdrop');
  var choiceClose = document.getElementById('export-choice-close');
  var choiceFoot = document.getElementById('export-choice-foot');
  var includeSpeakerNotesInput = document.getElementById('export-include-speaker-notes');
  var modeButtons = choiceBackdrop ? Array.prototype.slice.call(choiceBackdrop.querySelectorAll('[data-export-mode]')) : [];

  function setStatus(text){ if(status) status.textContent = text || ''; }

  function loadScript(src){
    return new Promise(function(resolve,reject){
      var found = Array.prototype.slice.call(document.scripts).find(function(s){ return s.src === src; });
      if(found){ resolve(); return; }
      var script=document.createElement('script');
      script.src=src;
      script.async=true;
      script.onload=function(){ resolve(); };
      script.onerror=function(){ reject(new Error('无法加载导出依赖：'+src)); };
      document.head.appendChild(script);
    });
  }

  async function ensureExportLibraries(){
    if(!window.html2canvas){
      await loadScript('lib/html2canvas.min.js');
    }
    if(!(window.pptxgen || window.PptxGenJS)){
      await loadScript('lib/pptxgen.bundle.js');
    }
    if(!window.html2canvas) throw new Error('html2canvas 未成功加载');
    if(!(window.pptxgen || window.PptxGenJS)) throw new Error('pptxgenjs 未成功加载');
  }

  function waitForImages(root){
    var imgs=Array.prototype.slice.call(root.querySelectorAll('img'));
    return Promise.all(imgs.map(function(img){
      if(img.complete && img.naturalWidth>0) return Promise.resolve();
      return new Promise(function(resolve){
        img.onload=resolve;
        img.onerror=resolve;
        setTimeout(resolve,3000);
      });
    }));
  }

  async function renderSlideToImage(slideEl){
    var stage=document.createElement('div');
    stage.className='export-hidden-stage';
    var clone=slideEl.cloneNode(true);
    clone.classList.add('active');
    clone.style.display='block';
    stage.appendChild(clone);
    document.body.appendChild(stage);
    await waitForImages(stage);
    await document.fonts.ready.catch(function(){});
    var canvas = await window.html2canvas(clone, {
      scale: EXPORT_SCALE,
      backgroundColor: null,
      useCORS: true,
      allowTaint: true,
      logging: false,
      width: EXPORT_W,
      height: EXPORT_H,
      windowWidth: EXPORT_W,
      windowHeight: EXPORT_H,
      scrollX: 0,
      scrollY: 0
    });
    document.body.removeChild(stage);
    return canvas.toDataURL('image/png');
  }

  async function exportToPPTX(){
    await ensureExportLibraries();
    var PptxCtor = window.pptxgen || window.PptxGenJS;
    var pptx = new PptxCtor();
    if(pptx.defineLayout){
      pptx.defineLayout({ name:'HTML_16_9', width:PPT_W, height:PPT_H });
      pptx.layout = 'HTML_16_9';
    }else{
      pptx.layout = 'LAYOUT_WIDE';
    }
    pptx.author = 'ChatGPT HTML PPT exporter';
    pptx.subject = 'Slides rendered from fixed 1280×720 HTML canvas';
    pptx.title = document.title || 'presentation';
    pptx.company = '';
    pptx.lang = 'zh-CN';

    var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
    for(var i=0;i<slides.length;i++){
      setStatus('导出 '+(i+1)+'/'+slides.length);
      var img = await renderSlideToImage(slides[i]);
      var p = pptx.addSlide();
      p.background = { color: 'FFFFFF' };
      p.addImage({ data: img, x: 0, y: 0, w: PPT_W, h: PPT_H });
    }
    setStatus('正在保存…');
    await pptx.writeFile({ fileName: 'presentation_exported_16x9.pptx' });
    setStatus('完成');
    setTimeout(function(){ setStatus(''); }, 3000);
  }

  async function exportToPPTXFromServer(mode){
    var params = new URLSearchParams(window.location.search);
    var token = params.get('token') || '';
    if(!token) throw new Error('控制端缺少 token，无法使用服务端导出');
    var exportMode = mode === 'advanced' || mode === 'editable' ? mode : 'normal';
    var includeSpeakerNotes = Boolean(includeSpeakerNotesInput && includeSpeakerNotesInput.checked);
    setStatus((exportMode === 'editable' ? '可编辑文字导出中…' : exportMode === 'advanced' ? '高级导出中…' : '普通导出中…') + (includeSpeakerNotes ? ' 含演讲稿' : ''));
    var res = await fetch('/api/export-pptx',{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Control-Token':token},
      body:JSON.stringify({token:token,mode:exportMode,includeSpeakerNotes:includeSpeakerNotes})
    });
    if(!res.ok){
      var msg='服务端导出失败';
      try{
        var data=await res.json();
        if(data && data.error) msg=data.error;
      }catch(err){}
      throw new Error(msg);
    }
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = exportMode === 'editable' ? 'presentation_editable_text.pptx' : exportMode === 'advanced' ? 'presentation_components.pptx' : 'presentation_exported_script.pptx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('完成');
    setTimeout(function(){ setStatus(''); }, 3000);
  }

  function shouldUseServerExport(){
    var params = new URLSearchParams(window.location.search);
    return (location.protocol==='http:' || location.protocol==='https:') && params.get('role')==='control' && Boolean(params.get('token'));
  }

  function isServerExportMode(mode){
    return mode === 'normal' || mode === 'advanced' || mode === 'editable';
  }

  function openExportChoice(){
    if(!choiceBackdrop) return;
    var serverReady = shouldUseServerExport();
    choiceBackdrop.classList.add('open');
    choiceBackdrop.setAttribute('aria-hidden','false');
    modeButtons.forEach(function(button){
      if(isServerExportMode(button.dataset.exportMode)){
        button.disabled = !serverReady;
        button.title = serverReady ? '使用服务端导出' : '该导出模式需要从带 token 的控制端服务打开';
      }else{
        button.disabled = false;
        button.title = '不调用服务，直接在浏览器中导出';
      }
    });
    if(choiceFoot){
      choiceFoot.textContent = serverReady
        ? '当前为控制端：前三种服务端导出由本地服务生成；勾选后会把 speaker-notes.json 写入 PPT 备注页。纯前端导出仍不包含演讲稿。'
        : '当前为本地文件或非控制端：仅纯前端导出可用，且不包含演讲稿；服务端普通、高级和可编辑文字导出需要启动带 token 的控制端服务。';
    }
  }

  function closeExportChoice(){
    if(!choiceBackdrop) return;
    choiceBackdrop.classList.remove('open');
    choiceBackdrop.setAttribute('aria-hidden','true');
  }

  async function runExportMode(mode){
    closeExportChoice();
    if(btn.disabled) return;
    btn.disabled = true;
    var oldText = btn.textContent;
    btn.textContent = mode === 'client' ? '前端导出中' : mode === 'editable' ? '可编辑导出中' : mode === 'advanced' ? '高级导出中' : '导出中';
    try{
      if(mode === 'client') await exportToPPTX();
      else if(isServerExportMode(mode) && shouldUseServerExport()) await exportToPPTXFromServer(mode);
      else throw new Error('该导出模式需要通过带 token 的控制端服务运行');
    }catch(err){
      console.error(err);
      setStatus('导出失败');
      alert('导出 PPTX 失败：' + (err && err.message ? err.message : err));
    }finally{
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  window.exportToPPTX = exportToPPTX;
  window.exportToPPTXFromServer = exportToPPTXFromServer;
  if(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      if(btn.disabled) return;
      openExportChoice();
    });
  }
  if(choiceClose) choiceClose.addEventListener('click', closeExportChoice);
  if(choiceBackdrop){
    choiceBackdrop.addEventListener('click', function(e){
      if(e.target === choiceBackdrop) closeExportChoice();
    });
  }
  modeButtons.forEach(function(button){
    button.addEventListener('click', function(e){
      e.stopPropagation();
      if(button.disabled) return;
      runExportMode(button.dataset.exportMode);
    });
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape') closeExportChoice();
  });
})();
