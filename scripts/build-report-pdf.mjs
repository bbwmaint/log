// Server-side twin of the app's shift-report PDF — same layout, same letterhead.
// Ported from index.html buildReportPDF(); renders with jsPDF under Node.
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

const BBW_LOGO = 'data:image/png;base64,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';

export function reportSummaryLines(R){
  var L=[];
  L.push(R.se.length+' task'+(R.se.length===1?'':'s')+' logged'+(R.techs.length?' by '+R.techs.join(', '):'')+'.');
  if(R.totalDT>0){
    var worst=R.dtEvents.slice().sort(function(a,b){return (b.dt||0)-(a.dt||0);})[0];
    L.push('Downtime: '+R.totalDT.toFixed(1)+' h across '+R.dtEvents.length+' event'+(R.dtEvents.length===1?'':'s')+(worst&&worst.assetName?' (worst: '+worst.assetName+' '+(worst.dt||0).toFixed(1)+'h)':'')+'.');
  } else { L.push('No machine downtime recorded. \u2713'); }
  if(R.totalCO>0){ L.push('Changeovers: '+R.coEvents.length+' totalling '+R.totalCO+' min'+(R.coTypes.length?' ('+R.coTypes.join(', ')+')':'')+'.'); }
  else { L.push('No changeovers this shift.'); }
  if(R.issues.length){ L.push(''+R.issues.length+' open issue'+(R.issues.length===1?'':'s')+' handed to next shift'+(R.issues.length?': '+R.issues.slice(0,3).map(function(e){var iss=(R.tmap&&R.tmap[e.issue])?R.tmap[e.issue]:e.issue;return (e.assetName||'?')+(iss?' ('+iss+')':'');}).join('; ')+(R.issues.length>3?'…':''):'')+'.'); }
  else { L.push('Clean handover \u2014 no pending issues. \u2713'); }
  if(R.parts.length){ L.push(R.parts.length+' part'+(R.parts.length===1?'':'s')+' awaiting order.'); }
  return L;
}

export function reportFileName(R){ return 'BBW_Shift_Report_'+R.date+'_'+R.shift+'.pdf'; }

export function buildReportPDF(R){
  function pdfSafe(s){return String(s==null?'':s).replace(/\u26A0/g,'!').replace(/\u2713/g,'').replace(/[\u2018\u2019]/g,"'").replace(/[\u201C\u201D]/g,'"').replace(/\u2014/g,'-').replace(/\u2026/g,'...').replace(/[\u2192]/g,'->');}
  var doc=new jsPDF({unit:'pt',format:'letter'});
  var RF='helvetica';
  try{
    if(typeof DEJAVU_REG!=='undefined'){
      doc.addFileToVFS('DejaVu.ttf',DEJAVU_REG); doc.addFont('DejaVu.ttf','DejaVu','normal');
      doc.addFileToVFS('DejaVu-Bold.ttf',DEJAVU_BOLD); doc.addFont('DejaVu-Bold.ttf','DejaVu','bold');
      RF='DejaVu';
    }
  }catch(e){ RF='helvetica'; }
  var W=doc.internal.pageSize.getWidth(), M=40, y=0;
  // Header
  doc.setFillColor(17,17,17); doc.rect(0,0,W,6,'F');
  y=44;
  doc.setTextColor(17,17,17); doc.setFont(RF,'bold'); doc.setFontSize(17);
  if(BBW_LOGO){try{var _lh=24,_lw=_lh*((1996)/(881));doc.addImage(BBW_LOGO,'PNG',M,y-22,_lw,_lh);}catch(e){doc.text('BRUNSWICK BIERWORKS', M, y);}}else{doc.text('BRUNSWICK BIERWORKS', M, y);}
  doc.setFont(RF,'normal'); doc.setFontSize(10.5); doc.setTextColor(120,120,120);
  doc.text('Maintenance Shift Handover Report', M, y+15);
  var shiftLabel=(R.shift==='Day'?'Day Shift  07:00–19:00':'Night Shift  19:00–07:00');
  doc.setFont(RF,'bold'); doc.setFontSize(12); doc.setTextColor(17,17,17);
  doc.text(shiftLabel, W-M, y, {align:'right'});
  doc.setFont(RF,'normal'); doc.setFontSize(10); doc.setTextColor(120,120,120);
  doc.text(R.date, W-M, y+15, {align:'right'});
  y+=30;
  doc.setDrawColor(17,17,17); doc.setLineWidth(1.2); doc.line(M,y,W-M,y);
  y+=20;
  // KPI tiles
  var tiles=[['Tasks',String(R.se.length),[245,245,247],[17,17,17]],
             ['Pending',String(R.issues.length),[254,242,242],[220,38,38]],
             ['Parts',String(R.parts.length),[255,247,237],[234,88,12]],
             ['Downtime',R.totalDT.toFixed(1)+'h',[255,251,235],[217,119,6]],
             ['Changeover',R.totalCO+'m',[255,251,235],[245,158,11]]];
  var gap=10, tw=(W-2*M-gap*(tiles.length-1))/tiles.length, th=46;
  tiles.forEach(function(t,i){
    var x=M+i*(tw+gap);
    doc.setFillColor(t[2][0],t[2][1],t[2][2]); doc.roundedRect(x,y,tw,th,6,6,'F');
    doc.setTextColor(t[3][0],t[3][1],t[3][2]); doc.setFont(RF,'bold'); doc.setFontSize(17);
    doc.text(t[1], x+tw/2, y+22, {align:'center'});
    doc.setTextColor(110,110,110); doc.setFont(RF,'normal'); doc.setFontSize(8);
    doc.text(t[0].toUpperCase(), x+tw/2, y+36, {align:'center'});
  });
  y+=th+18;
  // Smart summary box
  var lines=reportSummaryLines(R);
  doc.setFillColor(247,247,249); doc.roundedRect(M,y,W-2*M,18+lines.length*14,8,8,'F');
  doc.setTextColor(17,17,17); doc.setFont(RF,'bold'); doc.setFontSize(9.5);
  doc.text('SHIFT SUMMARY', M+14, y+16);
  doc.setFont(RF,'normal'); doc.setFontSize(10); doc.setTextColor(60,60,60);
  lines.forEach(function(l,i){ doc.text('\u2022 '+pdfSafe(l), M+14, y+32+i*14, {maxWidth:W-2*M-28}); });
  y+=18+lines.length*14+18;
  // Tables
  function tbl(title,color,head,body){
    if(!body.length)return;
    autoTable(doc,{startY:y,head:[head],body:body,margin:{left:M,right:M},
      styles:{font:RF,fontSize:9,cellPadding:5,overflow:'linebreak',valign:'top'},
      headStyles:{font:RF,fillColor:color,textColor:255,fontStyle:'bold',fontSize:8.5},
      alternateRowStyles:{fillColor:[250,250,250]},
      didDrawPage:function(){},
      willDrawPage:function(){},
      tableLineColor:[230,230,230],
      didParseCell:function(){},
      bodyStyles:{textColor:[40,40,40]},
      columnStyles:title.indexOf('Parts')>=0?{}:{0:{fontStyle:'bold',cellWidth:120}},
      didDrawCell:function(){},
      showHead:'everyPage',
      tableWidth:'auto',
      pageBreak:'auto',
      rowPageBreak:'avoid',
      headCallback:function(){},
      margin:{left:M,right:M,top:40},
      // section title via a custom hook before table:
    });
    y=doc.lastAutoTable.finalY+8;
  }
  function sectTitle(t,c,n){
    if(y>doc.internal.pageSize.getHeight()-90){doc.addPage();y=44;}
    doc.setFillColor(c[0],c[1],c[2]); doc.roundedRect(M,y,4,14,2,2,'F');
    doc.setTextColor(17,17,17); doc.setFont(RF,'bold'); doc.setFontSize(11.5);
    doc.text(t+'  ('+n+')', M+12, y+11);
    y+=20;
  }
  function tr(t){return (R.tmap&&R.tmap[t])?R.tmap[t]:t;}
  function descCell(e){var s=(e.issue?tr(e.issue):''); if(e.desc){s+=(s?'\n':'')+tr(e.desc);} return pdfSafe(s)||'-';}
  if(R.issues.length){ sectTitle('Pending Issues — Next Shift Must Action',[220,38,38],R.issues.length);
    tbl('Issues',[220,38,38],['Asset','Issue / Description','By'],R.issues.map(function(e){return [e.assetName||'General',descCell(e),e.who||''];})); }
  else { if(y>doc.internal.pageSize.getHeight()-90){doc.addPage();y=44;}
    doc.setFillColor(240,253,244); doc.roundedRect(M,y,W-2*M,26,6,6,'F');
    doc.setTextColor(22,163,74); doc.setFont(RF,'bold'); doc.setFontSize(10);
    doc.text('No pending issues - clean handover', M+14, y+17); y+=38; }
  sectTitle('Work Completed',[22,163,74],R.done.length);
  if(R.done.length) tbl('Completed',[22,163,74],['Asset','Issue / Description','Time','By'],R.done.map(function(e){return [e.assetName||'General',descCell(e),(e.start?e.start+(e.end?'-'+e.end:''):''),e.who||''];}));
  else { doc.setTextColor(150,150,150); doc.setFont(RF,'italic'); doc.setFontSize(9); doc.text('None this shift.',M,y+4); y+=18; }
  if(R.ongoing.length){ sectTitle('In Progress — Continue Next Shift',[217,119,6],R.ongoing.length);
    tbl('Ongoing',[217,119,6],['Asset','Issue / Description','Time','By'],R.ongoing.map(function(e){return [e.assetName||'General',descCell(e),(e.start?e.start+(e.end?'-'+e.end:''):''),e.who||''];})); }
  if(R.parts.length){ sectTitle('Parts to Order',[234,88,12],R.parts.length);
    tbl('Parts',[234,88,12],['Part','Asset','Qty','By'],R.parts.map(function(e){return [e.partName||e.issue||'—',e.assetName||'',e.partQty||'1',e.who||''];})); }
  // Attached photos (mostly parts) — embed all photos inline at the end.
  function entryPhotos(e){var ph=(e.photos&&e.photos.length)?e.photos:(e.photo?[e.photo]:[]);return ph.filter(function(p){return p&&typeof p==='string'&&p.indexOf('data:image')===0;});}
  var withPhotos=R.se.filter(function(e){return entryPhotos(e).length;});
  if(withPhotos.length){
    var totalPhotos=withPhotos.reduce(function(n,e){return n+entryPhotos(e).length;},0);
    if(y>doc.internal.pageSize.getHeight()-140){doc.addPage();y=44;}
    sectTitle('Attached Photos',[100,100,110],totalPhotos);
    var pageH=doc.internal.pageSize.getHeight();
    withPhotos.forEach(function(e){
      doc.setFont(RF,'bold'); doc.setFontSize(9.5); doc.setTextColor(40,40,40);
      var cap=pdfSafe((e.assetName||e.partName||'General')+(e.issue?' \u2014 '+tr(e.issue):'')+(e.who?'  ('+e.who+')':''));
      if(y+24>pageH-44){doc.addPage();y=44;}
      doc.text(cap, M, y); y+=11;
      entryPhotos(e).forEach(function(p){
        var props; try{ props=doc.getImageProperties(p); }catch(err){ return; }
        var maxW=W-2*M, maxH=300;
        var w=maxW, h=w*props.height/props.width;
        if(h>maxH){ h=maxH; w=h*props.width/props.height; }
        if(y+h>pageH-44){ doc.addPage(); y=44; }
        try{ doc.addImage(p, props.fileType||'JPEG', M, y, w, h, undefined, 'FAST'); }catch(err){}
        y+=h+10;
      });
      y+=6;
    });
  }
  // Footer on every page
  var pages=doc.internal.getNumberOfPages();
  for(var p=1;p<=pages;p++){ doc.setPage(p);
    doc.setTextColor(160,160,160); doc.setFont(RF,'normal'); doc.setFontSize(8);
    doc.text('Generated '+new Date().toLocaleString('en-CA')+(R.translated?'  \u00b7  Ukrainian entries auto-translated':''),M,doc.internal.pageSize.getHeight()-18);
    doc.text('Page '+p+' of '+pages,W-M,doc.internal.pageSize.getHeight()-18,{align:'right'});
  }
  return Buffer.from(doc.output('arraybuffer'));
}
