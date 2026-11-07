// The map uses the same account-owned prospects and evidence as the lead table.
export function createProspectMap({request,getRows,getEvidence,getUser,onOpenLead,escape}) {
  let map=null,layer=null,center=null,gps=null,radius=10,uid='',generation=0,centerSaved=false;
  const el=id=>document.getElementById(id);
  const message=text=>{el('mapMessage').textContent=text};
  const point=(lat,lon)=>{
    if(lat==null||lon==null||String(lat).trim()===''||String(lon).trim()==='')return null;
    lat=Number(lat);lon=Number(lon);
    return Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180?{lat,lon}:null;
  };
  function locate(row){
    const direct=point(row.latitude??row.lat,row.longitude??row.lng??row.lon);
    if(direct)return direct;
    const evidence=getEvidence().filter(e=>e.prospectId===row.id&&e.isCurrent!==false);
    for(const e of evidence){const p=point(e.profile?.latitude,e.profile?.longitude);if(p)return p}
    let meta={};try{meta=JSON.parse(String(row.notes||'').split('[VF-META]')[1]||'{}')}catch{}
    return point(meta.latitude,meta.longitude);
  }
  function distance(p){
    if(!center)return null;
    const rad=Math.PI/180,a=(p.lat-center.lat)*rad,b=(p.lon-center.lon)*rad;
    const h=Math.sin(a/2)**2+Math.cos(center.lat*rad)*Math.cos(p.lat*rad)*Math.sin(b/2)**2;
    return 3958.7613*2*Math.asin(Math.sqrt(Math.min(1,h)));
  }
  async function ensureMap(){
    if(map)return;
    if(!window.L){
      if(!document.querySelector('[data-forge-map-css]')){
        const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('./vendor/leaflet.css',import.meta.url).href;css.dataset.forgeMapCss='1';document.head.appendChild(css);
      }
      await new Promise((resolve,reject)=>{let script=document.querySelector('[data-forge-map-js]');if(!script){script=document.createElement('script');script.src=new URL('./vendor/leaflet.js',import.meta.url).href;script.dataset.forgeMapJs='1';document.head.appendChild(script)}script.addEventListener('load',resolve,{once:true});script.addEventListener('error',()=>{script.remove();reject(Error('Map could not load. Your lead list is still available.'))},{once:true})});
    }
    if(map)return;
    map=window.L.map(el('savedLeadMap')).setView([center?.lat??38,center?.lon??-97],4);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'}).addTo(map);
    layer=window.L.layerGroup().addTo(map);
  }
  function render(){
    if(!getUser())return;
    const niche=el('mapNiche').value,website=el('mapWebsite').value;
    const niches=[...new Set(getRows().map(r=>r.category).filter(Boolean))].sort();
    el('mapNiche').innerHTML='<option value="">All niches</option>'+niches.map(n=>'<option value="'+escape(n)+'">'+escape(n)+'</option>').join('');el('mapNiche').value=niche;
    const all=getRows().filter(r=>(!niche||r.category===niche)&&(!website||(website==='has'?Boolean(r.website):!r.website)));
    const items=all.map(row=>({row,p:locate(row)})).filter(i=>i.p).map(i=>({...i,miles:distance(i.p)})).filter(i=>!center||i.miles<=radius).sort((a,b)=>(a.miles??0)-(b.miles??0));
    el('mapCount').textContent=items.length+' mapped · '+all.filter(r=>!locate(r)).length+' need coordinates. Radius is straight-line distance; 0 means this exact point.';
    el('mapLeads').innerHTML=items.slice(0,300).map(({row,miles})=>'<button class="local-result map-lead" data-map-lead="'+escape(row.id)+'"><b>'+escape(row.businessName)+'</b><small>'+escape(row.city||'')+(miles===null?'':' · '+miles.toFixed(1)+' mi')+'</small></button>').join('')||'<p>No mapped leads in this area. Refresh coordinates or increase the radius.</p>';
    if(!map)return;
    map.invalidateSize();layer.clearLayers();
    if(center){window.L.circle([center.lat,center.lon],{radius:radius*1609.344,weight:1}).addTo(layer);window.L.circleMarker([center.lat,center.lon],{radius:9,color:'#20a070'}).addTo(layer).bindTooltip('Your saved starting point');map.setView([center.lat,center.lon],radius<=5?12:radius<=20?10:radius<=60?8:6)}
    const markers=[];
    items.forEach(({row,p})=>{const label=document.createElement('span');label.textContent=row.businessName;const m=window.L.circleMarker([p.lat,p.lon],{radius:6}).addTo(layer).bindTooltip(label);m.on('click',()=>onOpenLead(row));markers.push(m)});
    if(!center&&markers.length)map.fitBounds(window.L.featureGroup(markers).getBounds().pad(.15),{maxZoom:13});
  }
  async function reset(){
    generation++;uid=getUser()?.uid||'';center=null;gps=null;radius=10;centerSaved=false;
    if(layer)layer.clearLayers();el('mapLeads').textContent='';el('mapAddress').value='';el('mapRadius').value='10';el('mapRadiusValue').textContent='10 miles';el('updateMapAddress').disabled=true;message('');
    if(!uid)return;
    const expected=uid,run=generation;
    try{const saved=await request('/api/map-settings');if(getUser()?.uid!==expected||generation!==run)return;center=point(saved.latitude,saved.longitude);centerSaved=Boolean(center);radius=saved.radius??10;el('mapAddress').value=saved.addressLabel||'';el('mapRadius').value=String(radius);el('mapRadiusValue').textContent=radius+' miles';render()}catch(e){if(generation===run)message('Saved map settings unavailable: '+e.message)}
  }
  el('getMapLocation').addEventListener('click',()=>{
    if(!navigator.geolocation)return message('Location is unavailable in this browser.');
    const run=generation;message('Getting your location…');
    navigator.geolocation.getCurrentPosition(position=>{if(run!==generation)return;gps={lat:position.coords.latitude,lon:position.coords.longitude};center=gps;centerSaved=false;el('updateMapAddress').disabled=false;message('Location ready. Add an address label and tap Update my address to save this starting point. GPS accuracy: ±'+Math.round(position.coords.accuracy)+' m.');render()},error=>{if(run===generation)message(error.message)},{enableHighAccuracy:true,timeout:15000,maximumAge:60000});
  });
  el('updateMapAddress').addEventListener('click',async()=>{
    if(!gps)return message('Get your current location first.');
    const expected=uid, location={...gps};let address=el('mapAddress').value,warning='';
    el('updateMapAddress').disabled=true;message('Saving your starting address…');
    try{
      try{const resolved=await request('/api/map/reverse',{method:'POST',body:JSON.stringify({latitude:location.lat,longitude:location.lon})},{attempts:1});address=resolved.address||address}catch(e){warning=' Street address was unavailable; your coordinates and label were saved.'}
      if(uid!==expected)return;
      await request('/api/map-settings',{method:'PUT',body:JSON.stringify({latitude:location.lat,longitude:location.lon,addressLabel:address,radius})});
      if(uid===expected){centerSaved=true;el('mapAddress').value=address;message('Starting location saved to your account.'+warning)}
    }catch(e){if(uid===expected)message('Not saved: '+e.message)}finally{if(uid===expected)el('updateMapAddress').disabled=false}
  });
  el('mapRadius').addEventListener('input',()=>{radius=Number(el('mapRadius').value);el('mapRadiusValue').textContent=radius+' miles';render()});
  el('mapRadius').addEventListener('change',async()=>{if(!center||!centerSaved)return;try{await request('/api/map-settings',{method:'PUT',body:JSON.stringify({latitude:center.lat,longitude:center.lon,addressLabel:el('mapAddress').value,radius})})}catch(e){message('Radius not saved: '+e.message)}});
  ['mapNiche','mapWebsite'].forEach(id=>el(id).addEventListener('change',render));
  el('mapLeads').addEventListener('click',e=>{const id=e.target.closest('[data-map-lead]')?.dataset.mapLead;const row=getRows().find(r=>r.id===id);if(row)onOpenLead(row)});
  el('refreshMapLeads').addEventListener('click',async()=>{
    const ids=getRows().filter(r=>!locate(r)).slice(0,50).map(r=>r.id);
    if(!ids.length){render();return message('All saved leads with coordinates refreshed.')}
    el('refreshMapLeads').disabled=true;message('Locating up to 50 saved business addresses…');
    try{const data=await request('/api/map/geocode',{method:'POST',body:JSON.stringify({prospect_ids:ids})},{attempts:1,timeoutMs:60000});message(data.matched+' matched · '+data.unmapped+' not mapped. '+data.message);render()}catch(e){message(e.message)}finally{el('refreshMapLeads').disabled=false}
  });
  return {reset,render,open:async()=>{try{await ensureMap();render()}catch(e){message(e.message)}}};
}
