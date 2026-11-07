/* QR del panel (cobro por enlace). Copia del generador de kit-marca.html.
   Expone QRCode.create(texto,'M') y QRCode.renderToCanvas(qr,ctx,x,y,tam,margen,oscuro,claro). */
/* =====================================================================
   QR Code generator (compact, vanilla). Based on qrcode-generator
   by Kazuhiko Arase (MIT). Byte mode (UTF-8), EC L/M/Q/H, auto type.
   ===================================================================== */
var QRCode=(function(){
  var EXP=new Array(256),LOG=new Array(256);
  for(var i=0;i<8;i++)EXP[i]=1<<i;
  for(var i=8;i<256;i++)EXP[i]=EXP[i-4]^EXP[i-5]^EXP[i-6]^EXP[i-8];
  for(var i=0;i<255;i++)LOG[EXP[i]]=i;
  function glog(n){if(n<1)throw new Error('glog');return LOG[n];}
  function gexp(n){while(n<0)n+=255;while(n>=256)n-=255;return EXP[n];}
  function Poly(num,shift){var off=0;while(off<num.length&&num[off]===0)off++;this.num=new Array(num.length-off+shift);for(var i=0;i<num.length-off;i++)this.num[i]=num[i+off];}
  Poly.prototype={
    get:function(i){return this.num[i];},
    getLength:function(){return this.num.length;},
    multiply:function(e){var num=new Array(this.getLength()+e.getLength()-1);for(var i=0;i<num.length;i++)num[i]=0;for(var i=0;i<this.getLength();i++)for(var j=0;j<e.getLength();j++)num[i+j]^=gexp(glog(this.get(i))+glog(e.get(j)));return new Poly(num,0);},
    mod:function(e){if(this.getLength()-e.getLength()<0)return this;var ratio=glog(this.get(0))-glog(e.get(0));var num=new Array(this.getLength());for(var i=0;i<this.getLength();i++)num[i]=this.get(i);for(var i=0;i<e.getLength();i++)num[i]^=gexp(glog(e.get(i))+ratio);return new Poly(num,0).mod(e);}
  };
  var RS=[
    [1,26,19],[1,26,16],[1,26,13],[1,26,9],
    [1,44,34],[1,44,28],[1,44,22],[1,44,16],
    [1,70,55],[1,70,44],[2,35,17],[2,35,13],
    [1,100,80],[2,50,32],[2,50,24],[4,25,9],
    [1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],
    [2,86,68],[4,43,27],[4,43,19],[4,43,15],
    [2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],
    [2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],
    [2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],
    [2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],
    [4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],
    [2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],
    [4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],
    [3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],
    [5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],
    [5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],
    [1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],
    [5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],
    [3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],
    [3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],
    [4,144,116,4,145,117],[17,68,42,0,0,0],[17,50,22,6,51,23],[19,46,16,6,47,17],
    [2,139,111,7,140,112],[17,74,46,0,0,0],[7,54,24,16,55,25],[34,37,13,0,0,0],
    [4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],
    [6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],
    [8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],
    [10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],
    [8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],
    [3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],
    [7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],
    [5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],
    [13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],
    [17,145,115,0,0,0],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],
    [17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],
    [13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],
    [12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],
    [6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],
    [17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],
    [4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],
    [20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],
    [19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]
  ];
  var ECI={L:0,M:1,Q:2,H:3};
  function rsBlocks(t,ec){var b=RS[(t-1)*4+ECI[ec]],list=[],len=b.length/3;for(var i=0;i<len;i++){var cnt=b[i*3],tot=b[i*3+1],dc=b[i*3+2];for(var j=0;j<cnt;j++)list.push({tot:tot,dc:dc});}return list;}
  function BitBuf(){this.buffer=[];this.length=0;}
  BitBuf.prototype={
    put:function(num,len){for(var i=0;i<len;i++)this.putBit(((num>>>(len-i-1))&1)===1);},
    putBit:function(bit){var b=Math.floor(this.length/8);if(this.buffer.length<=b)this.buffer.push(0);if(bit)this.buffer[b]|=(0x80>>>(this.length%8));this.length++;}
  };
  function ecPoly(len){var a=new Poly([1],0);for(var i=0;i<len;i++)a=a.multiply(new Poly([1,gexp(i)],0));return a;}
  function createBytes(buf,blocks){
    var offset=0,maxDc=0,maxEc=0,dcd=new Array(blocks.length),ecd=new Array(blocks.length);
    for(var r=0;r<blocks.length;r++){
      var dcCount=blocks[r].dc,ecCount=blocks[r].tot-dcCount;
      maxDc=Math.max(maxDc,dcCount);maxEc=Math.max(maxEc,ecCount);
      dcd[r]=new Array(dcCount);
      for(var i=0;i<dcd[r].length;i++)dcd[r][i]=0xff&buf.buffer[i+offset];
      offset+=dcCount;
      var rp=ecPoly(ecCount),raw=new Poly(dcd[r],rp.getLength()-1),mod=raw.mod(rp);
      ecd[r]=new Array(rp.getLength()-1);
      for(var i=0;i<ecd[r].length;i++){var mi=i+mod.getLength()-ecd[r].length;ecd[r][i]=(mi>=0)?mod.get(mi):0;}
    }
    var total=0;for(var i=0;i<blocks.length;i++)total+=blocks[i].tot;
    var data=new Array(total),idx=0;
    for(var i=0;i<maxDc;i++)for(var r=0;r<blocks.length;r++)if(i<dcd[r].length)data[idx++]=dcd[r][i];
    for(var i=0;i<maxEc;i++)for(var r=0;r<blocks.length;r++)if(i<ecd[r].length)data[idx++]=ecd[r][i];
    return data;
  }
  var PAD0=0xEC,PAD1=0x11;
  function utf8(str){var out=[];for(var i=0;i<str.length;i++){var c=str.charCodeAt(i);if(c<0x80)out.push(c);else if(c<0x800){out.push(0xc0|(c>>6));out.push(0x80|(c&0x3f));}else if(c<0xd800||c>=0xe000){out.push(0xe0|(c>>12));out.push(0x80|((c>>6)&0x3f));out.push(0x80|(c&0x3f));}else{i++;var c2=0x10000+(((c&0x3ff)<<10)|(str.charCodeAt(i)&0x3ff));out.push(0xf0|(c2>>18));out.push(0x80|((c2>>12)&0x3f));out.push(0x80|((c2>>6)&0x3f));out.push(0x80|(c2&0x3f));}}return out;}
  function QR(t,ec){this.t=t;this.ec=ec;this.modules=null;this.count=0;this.cache=null;this.list=[];}
  QR.prototype={
    addData:function(d){this.list.push(utf8(d));this.cache=null;},
    isDark:function(r,c){return this.modules[r][c];},
    getModuleCount:function(){return this.count;},
    make:function(){this.makeImpl(false,this.bestMask());},
    makeImpl:function(test,mask){
      this.count=this.t*4+17;this.modules=[];
      for(var r=0;r<this.count;r++){this.modules.push(new Array(this.count));for(var c=0;c<this.count;c++)this.modules[r][c]=null;}
      this.probe(0,0);this.probe(this.count-7,0);this.probe(0,this.count-7);
      this.adjust();this.timing();this.typeInfo(test,mask);
      if(this.t>=7)this.typeNumber(test);
      if(this.cache==null)this.cache=this.createData();
      this.mapData(this.cache,mask);
    },
    probe:function(row,col){for(var r=-1;r<=7;r++){if(row+r<=-1||this.count<=row+r)continue;for(var c=-1;c<=7;c++){if(col+c<=-1||this.count<=col+c)continue;this.modules[row+r][col+c]=(0<=r&&r<=6&&(c==0||c==6))||(0<=c&&c<=6&&(r==0||r==6))||(2<=r&&r<=4&&2<=c&&c<=4);}}},
    timing:function(){for(var r=8;r<this.count-8;r++){if(this.modules[r][6]!=null)continue;this.modules[r][6]=(r%2==0);}for(var c=8;c<this.count-8;c++){if(this.modules[6][c]!=null)continue;this.modules[6][c]=(c%2==0);}},
    adjust:function(){var pos=QR.PPT[this.t-1];for(var i=0;i<pos.length;i++)for(var j=0;j<pos.length;j++){var row=pos[i],col=pos[j];if(this.modules[row][col]!=null)continue;for(var r=-2;r<=2;r++)for(var c=-2;c<=2;c++)this.modules[row+r][col+c]=(r==-2||r==2||c==-2||c==2||(r==0&&c==0));}},
    typeNumber:function(test){var bits=QR.bchNum(this.t);for(var i=0;i<18;i++){var m=(!test&&((bits>>i)&1)==1);this.modules[Math.floor(i/3)][i%3+this.count-8-3]=m;}for(var i=0;i<18;i++){var m=(!test&&((bits>>i)&1)==1);this.modules[i%3+this.count-8-3][Math.floor(i/3)]=m;}},
    typeInfo:function(test,mask){var data=(QR.ECB[this.ec]<<3)|mask;var bits=QR.bchInfo(data);for(var i=0;i<15;i++){var m=(!test&&((bits>>i)&1)==1);if(i<6)this.modules[i][8]=m;else if(i<8)this.modules[i+1][8]=m;else this.modules[this.count-15+i][8]=m;}for(var i=0;i<15;i++){var m=(!test&&((bits>>i)&1)==1);if(i<8)this.modules[8][this.count-i-1]=m;else if(i<9)this.modules[8][15-i-1+1]=m;else this.modules[8][15-i-1]=m;}this.modules[this.count-8][8]=(!test);},
    mapData:function(data,mask){var inc=-1,row=this.count-1,bitIndex=7,byteIndex=0;for(var col=this.count-1;col>0;col-=2){if(col==6)col--;while(true){for(var c=0;c<2;c++){if(this.modules[row][col-c]==null){var dark=false;if(byteIndex<data.length)dark=(((data[byteIndex]>>>bitIndex)&1)==1);var mk=QR.mask(mask,row,col-c);if(mk)dark=!dark;this.modules[row][col-c]=dark;bitIndex--;if(bitIndex==-1){byteIndex++;bitIndex=7;}}}row+=inc;if(row<0||this.count<=row){row-=inc;inc=-inc;break;}}}},
    createData:function(){var buf=new BitBuf(),blocks=rsBlocks(this.t,this.ec);for(var i=0;i<this.list.length;i++){var b=this.list[i];buf.put(4,4);buf.put(b.length,this.lenBits());for(var j=0;j<b.length;j++)buf.put(b[j],8);}var totalData=0;for(var i=0;i<blocks.length;i++)totalData+=blocks[i].dc;if(buf.length+4<=totalData*8)buf.put(0,4);while(buf.length%8!=0)buf.putBit(false);while(true){if(buf.length>=totalData*8)break;buf.put(PAD0,8);if(buf.length>=totalData*8)break;buf.put(PAD1,8);}return createBytes(buf,blocks);},
    lenBits:function(){return(this.t<10)?8:16;},
    bestMask:function(){var min=0,pat=0;for(var i=0;i<8;i++){this.makeImpl(true,i);var lp=QR.lostPoint(this);if(i==0||min>lp){min=lp;pat=i;}}return pat;}
  };
  QR.PPT=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]];
  QR.ECB={L:1,M:0,Q:3,H:2};
  var G15=(1<<10)|(1<<8)|(1<<5)|(1<<4)|(1<<2)|(1<<1)|(1<<0);
  var G18=(1<<12)|(1<<11)|(1<<10)|(1<<9)|(1<<8)|(1<<5)|(1<<2)|(1<<0);
  var G15M=(1<<14)|(1<<12)|(1<<10)|(1<<4)|(1<<1);
  function bchDigit(d){var n=0;while(d!=0){n++;d>>>=1;}return n;}
  QR.bchInfo=function(data){var d=data<<10;while(bchDigit(d)-bchDigit(G15)>=0)d^=(G15<<(bchDigit(d)-bchDigit(G15)));return((data<<10)|d)^G15M;};
  QR.bchNum=function(data){var d=data<<12;while(bchDigit(d)-bchDigit(G18)>=0)d^=(G18<<(bchDigit(d)-bchDigit(G18)));return(data<<12)|d;};
  QR.mask=function(p,i,j){switch(p){case 0:return(i+j)%2==0;case 1:return i%2==0;case 2:return j%3==0;case 3:return(i+j)%3==0;case 4:return(Math.floor(i/2)+Math.floor(j/3))%2==0;case 5:return(i*j)%2+(i*j)%3==0;case 6:return((i*j)%2+(i*j)%3)%2==0;case 7:return((i*j)%3+(i+j)%2)%2==0;default:throw new Error('mask');}};
  QR.lostPoint=function(qr){var n=qr.getModuleCount(),lp=0;for(var row=0;row<n;row++)for(var col=0;col<n;col++){var same=0,dark=qr.isDark(row,col);for(var r=-1;r<=1;r++){if(row+r<0||n<=row+r)continue;for(var c=-1;c<=1;c++){if(col+c<0||n<=col+c)continue;if(r==0&&c==0)continue;if(dark==qr.isDark(row+r,col+c))same++;}}if(same>5)lp+=(3+same-5);}for(var row=0;row<n-1;row++)for(var col=0;col<n-1;col++){var cnt=0;if(qr.isDark(row,col))cnt++;if(qr.isDark(row+1,col))cnt++;if(qr.isDark(row,col+1))cnt++;if(qr.isDark(row+1,col+1))cnt++;if(cnt==0||cnt==4)lp+=3;}for(var row=0;row<n;row++)for(var col=0;col<n-6;col++){if(qr.isDark(row,col)&&!qr.isDark(row,col+1)&&qr.isDark(row,col+2)&&qr.isDark(row,col+3)&&qr.isDark(row,col+4)&&!qr.isDark(row,col+5)&&qr.isDark(row,col+6))lp+=40;}for(var col=0;col<n;col++)for(var row=0;row<n-6;row++){if(qr.isDark(row,col)&&!qr.isDark(row+1,col)&&qr.isDark(row+2,col)&&qr.isDark(row+3,col)&&qr.isDark(row+4,col)&&!qr.isDark(row+5,col)&&qr.isDark(row+6,col))lp+=40;}var dc=0;for(var col=0;col<n;col++)for(var row=0;row<n;row++)if(qr.isDark(row,col))dc++;var ratio=Math.abs(100*dc/n/n-50)/5;lp+=ratio*10;return lp;};
  function capBytes(t,ec){var blocks=rsBlocks(t,ec),total=0;for(var i=0;i<blocks.length;i++)total+=blocks[i].dc;var lb=(t<10)?8:16;return Math.floor((total*8-4-lb)/8);}
  function create(text,ec){ec=ec||'M';var bytes=utf8(text),t=1;for(;t<=40;t++){if(capBytes(t,ec)>=bytes.length)break;}if(t>40)throw new Error('Data too long');var qr=new QR(t,ec);qr.addData(text);qr.make();return qr;}
  function renderToCanvas(qr,ctx,x,y,size,margin,dark,light){margin=(margin==null)?4:margin;var n=qr.getModuleCount(),total=n+margin*2,cell=size/total;if(light){ctx.fillStyle=light;ctx.fillRect(x,y,size,size);}ctx.fillStyle=dark||'#000';for(var r=0;r<n;r++)for(var c=0;c<n;c++){if(qr.isDark(r,c)){var px=x+(margin+c)*cell,py=y+(margin+r)*cell;ctx.fillRect(Math.round(px),Math.round(py),Math.ceil(cell),Math.ceil(cell));}}}
  return{create:create,renderToCanvas:renderToCanvas};
})();
