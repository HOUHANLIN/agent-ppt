(function(){
  var area=document.querySelector('.slide-area');
  if(!area || document.querySelector('.deck')) return;
  var slides=Array.prototype.slice.call(area.querySelectorAll('.slide'));
  var stage=document.createElement('div');
  stage.className='stage';
  var deck=document.createElement('div');
  deck.className='deck';
  area.insertBefore(stage, slides[0] || null);
  stage.appendChild(deck);
  slides.forEach(function(slide){deck.appendChild(slide);});

  function fitDeck(){
    var w=area.clientWidth || window.innerWidth;
    var h=area.clientHeight || window.innerHeight;
    var scale=Math.min(w/1280, h/720);
    if(!isFinite(scale) || scale<=0) scale=0.1;
    scale=Math.max(0.10, scale);
    stage.style.width=(1280*scale)+'px';
    stage.style.height=(720*scale)+'px';
    deck.style.transform='scale('+scale+')';
  }
  window.addEventListener('resize', fitDeck);
  document.addEventListener('fullscreenchange', fitDeck);
  document.addEventListener('webkitfullscreenchange', fitDeck);
  fitDeck();
})();
