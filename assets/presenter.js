(function(){
  var slides=document.querySelectorAll('.slide');
  var total=slides.length;
  var current=0;
  var counter=document.getElementById('slide-counter');
  var bar=document.getElementById('progress-bar');
  var thumbPanel=document.getElementById('thumb-panel');
  var syncStatus=document.getElementById('sync-status');
  var btnPrev=document.getElementById('btn-prev');
  var btnNext=document.getElementById('btn-next');
  var btnFs=document.getElementById('btn-fs');
  var notesPanel=document.getElementById('speaker-notes-panel');
  var notesToggle=document.getElementById('speaker-notes-toggle');
  var notesMeta=document.getElementById('speaker-notes-meta');
  var notesText=document.getElementById('speaker-notes-text');
  var notesNext=document.getElementById('speaker-notes-next');
  var params=new URLSearchParams(window.location.search);
  var role=params.get('role') || 'standalone';
  var token=params.get('token') || '';
  var exportSlideParam=params.get('exportSlide');
  var isExportMode=exportSlideParam!==null;
  var isControl=role==='control';
  var isAudience=role==='audience';
  var isHttpMode=location.protocol==='http:' || location.protocol==='https:';
  var isServerControl=isHttpMode && isControl;
  var isPresenterMode=!isAudience && !isExportMode;
  var lastBroadcastPage=null;
  var speakerNotes={};
  var notesLoadState=isPresenterMode?'loading':'idle';

  if(isExportMode){
    document.body.classList.add('export-mode');
  }

  if(isPresenterMode){
    document.body.classList.add('controller-notes-active');
  }

  if(isAudience){
    document.body.classList.add('audience-mode');
  }

  function setSyncStatus(text){
    if(syncStatus) syncStatus.textContent=text;
  }

  function canControlSlides(){
    return !isAudience;
  }

  function getSlideTitle(index){
    var slide=slides[index];
    if(!slide) return '';
    if(slide.dataset.title) return slide.dataset.title;
    var h1=slide.querySelector('h1');
    if(h1) return h1.textContent.trim();
    return 'Slide '+(index+1);
  }

  function updateSpeakerNotes(){
    if(!isPresenterMode || !notesPanel) return;
    var pageKey=String(current+1);
    var title=getSlideTitle(current);
    var nextTitle=current+1<total?getSlideTitle(current+1):'已经是最后一页';
    var note=speakerNotes[pageKey];
    if(typeof note!=='string' || !note.trim()){
      note=notesLoadState==='error'?'注释文件未加载。服务模式请确认 speaker-notes.json 与 template.html 位于同一目录；本地文件模式请确认 HTML 内已包含 speaker-notes-data。':'本页暂无演讲者注释';
    }
    if(notesMeta) notesMeta.textContent=(current+1)+'/'+total+' ｜ '+title;
    if(notesText) notesText.textContent=note;
    if(notesNext){
      var nextText=notesNext.querySelector('span');
      if(nextText) nextText.textContent=nextTitle;
    }
  }

  function loadSpeakerNotes(){
    if(!isPresenterMode) return;
    if(notesPanel) notesPanel.classList.add('visible');
    if(!isServerControl){
      try{
        var embedded=document.getElementById('speaker-notes-data');
        speakerNotes=embedded && embedded.textContent ? JSON.parse(embedded.textContent) : {};
        notesLoadState='ready';
      }catch(err){
        console.error('Embedded speaker notes parse failed:',err);
        speakerNotes={};
        notesLoadState='error';
      }
      updateSpeakerNotes();
      return;
    }
    fetch('/api/speaker-notes?token='+encodeURIComponent(token),{cache:'no-cache'}).then(function(res){
      if(!res.ok) throw new Error('HTTP '+res.status);
      return res.json();
    }).then(function(data){
      if(!data || Object.prototype.toString.call(data)!=='[object Object]') throw new Error('Invalid notes JSON');
      speakerNotes=data;
      notesLoadState='ready';
      updateSpeakerNotes();
    }).catch(function(err){
      console.error('Speaker notes load failed:',err);
      speakerNotes={};
      notesLoadState='error';
      updateSpeakerNotes();
    });
  }

  function broadcastPage(n){
    if(!isServerControl) return;
    if(!token){
      setSyncStatus('控制端：缺少密钥');
      return;
    }
    if(lastBroadcastPage===n) return;
    lastBroadcastPage=n;
    fetch('/api/control',{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Control-Token':token},
      body:JSON.stringify({page:n,total:total,token:token})
    }).then(function(res){
      if(!res.ok) throw new Error(res.status===401?'密钥错误':'同步失败');
      setSyncStatus('控制端：已同步');
    }).catch(function(err){
      setSyncStatus('控制端：'+(err&&err.message?err.message:'同步失败'));
    });
  }

  function connectAudience(){
    if(!window.EventSource){
      setSyncStatus('观众端：浏览器不支持');
      return;
    }
    setSyncStatus('观众端：连接中');
    var events=new EventSource('/api/events');
    events.addEventListener('open',function(){
      setSyncStatus('观众端：已连接');
    });
    events.addEventListener('page',function(e){
      try{
        var data=JSON.parse(e.data);
        if(Number.isInteger(data.page)) show(data.page,{silent:true,remote:true});
        setSyncStatus('观众端：已同步');
      }catch(err){
        setSyncStatus('观众端：数据错误');
      }
    });
    events.addEventListener('error',function(){
      setSyncStatus('观众端：重连中');
    });
  }

  // --- Dynamic thumbnail generation ---
  // Each slide can declare metadata via data-title and data-section attributes.
  // Fallback: derive title from h1 / .eyebrow / "Slide N".
  function buildThumbs(){
    thumbPanel.innerHTML='';
    var sectionLabels=[
      {cls:'slide--cover',title:'封面页',section:'首页 / 标题 / 汇报信息'},
      {cls:'slide--toc',title:'目录页',section:'目录 / 汇报结构'},
      {cls:'slide--divider',title:'主题页',section:'章节分隔 / PART 标题'}
    ];
    for(var i=0;i<total;i++){
      var s=slides[i];
      var label={title:'Slide '+(i+1),section:''};
      // Check data-attributes first
      if(s.dataset.title) label.title=s.dataset.title;
      if(s.dataset.section) label.section=s.dataset.section;
      // Then check known classes
      if(!s.dataset.title){
        for(var k=0;k<sectionLabels.length;k++){
          if(s.classList.contains(sectionLabels[k].cls)){
            label.title=sectionLabels[k].title;
            label.section=sectionLabels[k].section;
            break;
          }
        }
        // Fallback: use h1 text
        if(!s.classList.contains('slide--cover')&&!s.classList.contains('slide--toc')&&!s.classList.contains('slide--divider')){
          var h1=s.querySelector('h1');
          if(h1) label.title=h1.textContent.trim().slice(0,20);
        }
      }
      var item=document.createElement('div');
      item.className='thumb-item'+(i===current?' active':'');
      item.innerHTML='<span class="thumb-num">'+(i+1)+'</span><span class="thumb-title">'+label.title+'</span>'+(label.section?'<span class="thumb-section">'+label.section+'</span>':'');
      (function(idx){item.addEventListener('click',function(){if(canControlSlides())show(idx)})})(i);
      thumbPanel.appendChild(item);
    }
  }
  buildThumbs();

  function show(n,options){
    options=options||{};
    if(n<0||n>=total)return;
    current=n;
    for(var i=0;i<total;i++){
      slides[i].classList.toggle('active',i===n);
    }
    var thumbs=thumbPanel.querySelectorAll('.thumb-item');
    for(var i=0;i<thumbs.length;i++){
      thumbs[i].classList.toggle('active',i===n);
    }
    counter.textContent=(current+1)+'/'+total;
    bar.style.width=((current+1)/total*100)+'%';
    if(thumbs[n])thumbs[n].scrollIntoView({behavior:'smooth',block:'nearest'});
    updateSpeakerNotes();
    if(!options.silent) broadcastPage(n);
  }
  function next(){if(canControlSlides())show(current+1)}
  function prev(){if(canControlSlides())show(current-1)}
  function goFS(){
    var el=document.documentElement;
    if(!document.fullscreenElement)(el.requestFullscreen||el.webkitRequestFullscreen||el.msRequestFullscreen).call(el);
    else(document.exitFullscreen||document.webkitExitFullscreen||document.msExitFullscreen).call(document);
  }

  document.addEventListener('keydown',function(e){
    var k=e.key;
    if(isAudience){
      if(k==='f'||k==='F'){
        e.preventDefault();
        goFS();
      }
      return;
    }
    if(k==='ArrowRight'||k===' '||k==='ArrowDown'||k==='PageDown'){e.preventDefault();next()}
    else if(k==='ArrowLeft'||k==='ArrowUp'||k==='PageUp'){e.preventDefault();prev()}
    else if(k==='f'||k==='F'){e.preventDefault();goFS()}
    else if(k==='Home'){e.preventDefault();if(canControlSlides())show(0)}
    else if(k==='End'){e.preventDefault();if(canControlSlides())show(total-1)}
    else if(k==='Escape'&&document.fullscreenElement)(document.exitFullscreen||document.webkitExitFullscreen).call(document);
  });

  if(isAudience){
    if(btnPrev)btnPrev.disabled=true;
    if(btnNext)btnNext.disabled=true;
  }

  if(btnPrev)btnPrev.onclick=function(e){e.stopPropagation();prev()};
  if(btnNext)btnNext.onclick=function(e){e.stopPropagation();next()};
  if(btnFs)btnFs.onclick=function(e){e.stopPropagation();goFS()};
  if(notesToggle)notesToggle.onclick=function(e){
    e.stopPropagation();
    if(!notesPanel) return;
    notesPanel.classList.toggle('collapsed');
    document.body.classList.toggle('notes-collapsed',notesPanel.classList.contains('collapsed'));
    notesToggle.textContent=notesPanel.classList.contains('collapsed')?'展开':'收起';
    window.dispatchEvent(new Event('resize'));
  };

  if(isExportMode){
    setSyncStatus('导出');
  }else if(isServerControl){
    setSyncStatus(token?'控制端：待同步':'控制端：缺少密钥');
    loadSpeakerNotes();
  }else if(isAudience){
    connectAudience();
  }else if(isPresenterMode){
    setSyncStatus('本地演讲者');
    loadSpeakerNotes();
  }else{
    setSyncStatus('单机');
  }

  var initialSlide=0;
  if(isExportMode){
    initialSlide=Math.max(0,Math.min(total-1,(parseInt(exportSlideParam,10)||1)-1));
  }
  show(initialSlide,{silent:!isControl || isExportMode});
})();
