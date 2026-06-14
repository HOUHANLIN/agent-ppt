(function(){
  function classifyBox(box){
    var img=box.querySelector('img');
    if(!img) return;
    function apply(){
      var w=img.naturalWidth || img.width;
      var h=img.naturalHeight || img.height;
      if(!w || !h) return;
      var r=w/h;
      box.classList.remove('auto-wide','auto-landscape','auto-standard','auto-square','auto-portrait','auto-tall');
      if(r>=2.05) box.classList.add('auto-wide');
      else if(r>=1.45) box.classList.add('auto-landscape');
      else if(r>=1.12) box.classList.add('auto-standard');
      else if(r>=0.88) box.classList.add('auto-square');
      else if(r>=0.58) box.classList.add('auto-portrait');
      else box.classList.add('auto-tall');
      if(!box.classList.contains('cover')) box.classList.add('contain');
      box.dataset.imgRatio = r.toFixed(2);
    }
    if(img.complete && img.naturalWidth) apply();
    else img.addEventListener('load', apply, {once:true});
  }
  function fitAllImages(root){
    Array.prototype.slice.call((root||document).querySelectorAll('.imgbox.auto, .auto-imgbox, [data-auto-fit="image"]')).forEach(classifyBox);
  }
  window.fitAllImages = fitAllImages;
  document.addEventListener('DOMContentLoaded', function(){fitAllImages(document);});
})();
