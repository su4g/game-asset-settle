/* Read only current-user identity. Never use a nickname, wallet, cookie or seller as an account key. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.BuffAccount=api;
})(typeof self==='undefined'?null:self,()=>{
  'use strict';
  const origin='https://buff.163.com';
  const headers='.nav_user,.nav-user,#j_user,#navbar-user-name,.navbar-user-name,.nav-user-name,.header-user,.top-user,#navbar-user,.navbar-user,[data-current-user-id]';
  const excluded='[data-buff-helper],#buff-helper-panel,#sell_order_list,[data-role="sell-order-list"],.order-detail,.order_detail';
  const attributes=['data-current-user-id','data-userid','data-user-id','data-uid'];
  const userKeys=['user_id','userid','userId','uid','id'];
  const scriptCache=new WeakMap();
  function userId(value) {
    if(typeof value==='number'&&!Number.isSafeInteger(value))return null;
    if(typeof value!=='string'&&typeof value!=='number')return null;
    const id=String(value).trim();
    return /^(?:U)?[1-9]\d{0,24}$/.test(id)?id:null;
  }
  function buffUrl(value) {
    try{const u=new URL(value,origin);return u.origin===origin?u:null;}catch{return null;}
  }
  function idFromUrl(value) {
    const u=buffUrl(value);if(!u)return null;
    const match=u.pathname.match(/^\/(?:user|user-center)\/(U?\d+)\/?$/)||u.pathname.match(/^\/shop\/(U\d+)\/?$/);
    return match?userId(match[1]):null;
  }
  function canonical(value) {
    if(typeof value!=='string'||!value.startsWith('buff:'))return null;
    const raw=value.slice(5),id=userId(raw)||idFromUrl(raw);
    return id?'buff:'+id:null;
  }
  function compatible(current,expected) {
    return current===expected||!!canonical(current)&&canonical(current)===canonical(expected);
  }
  function record(value) {
    if(value===null||value===false)return {ids:[],signedOut:true};
    if(!value||typeof value!=='object'||Array.isArray(value))return {ids:[],signedOut:false};
    const ids=userKeys.map(key=>userId(value[key])).filter(Boolean);
    return {ids,signedOut:value.is_login===false||value.logged_in===false};
  }
  // Only literal top-level assignments are accepted. Do not execute page JavaScript or
  // scan every "id" in an inline bundle (which also contains other users and sell orders).
  function statements(source) {
    const result=[];let value='',quote=null,comment=null,depth=0;
    for(let i=0;i<source.length;i++) {
      const c=source[i],next=source[i+1];
      if(comment==='line'){if(c==='\n'){comment=null;value+=' ';}continue;}
      if(comment==='block'){if(c==='*'&&next==='/'){comment=null;i++;value+=' ';}continue;}
      if(quote){value+=c;if(c==='\\'&&next){value+=next;i++;}else if(c===quote)quote=null;continue;}
      if(c==='/'&&next==='/'){comment='line';i++;continue;}
      if(c==='/'&&next==='*'){comment='block';i++;continue;}
      // A small literal reader is not a JavaScript interpreter. Reject ambiguous
      // regex/template syntax instead of mistaking text inside it for an assignment.
      if(c==='/'||c==='`')return [];
      if(c==='"'||c==="'"){quote=c;value+=c;continue;}
      if('({['.includes(c))depth++;
      if(')}]'.includes(c))depth--;
      if(depth<0)return [];
      if(c===';'&&depth===0){result.push(value.trim());value='';}else value+=c;
    }
    if(!quote&&!comment&&depth===0&&value.trim())result.push(value.trim());
    return result;
  }
  function initializers(source) {
    const changes=[];
    if(typeof source!=='string'||source.length>256000)return changes;
    for(const statement of statements(source)) {
      const match=statement.match(/^(?:(?:var|let|const)\s+)?((?:window\.)?g(?:\.(?:user|user_info|userInfo|user_id|userid|userId))?|(?:window\.)?(?:currentUser|current_user|userInfo|user_info))\s*=\s*([\s\S]+)$/);
      if(!match)continue;
      let data;try{data=JSON.parse(match[2]);}catch{continue;}
      const target=match[1].replace(/^window\./,'');
      if(target==='g') {
        changes.push(['g',null]);
        for(const key of ['user','user_info','userInfo'])if(Object.hasOwn(data||{},key))changes.push(['g.'+key,record(data[key])]);
      } else changes.push([target,/^g\.(?:user_id|userid|userId)$/.test(target)?{ids:[userId(data)].filter(Boolean),signedOut:data===null}:record(data)]);
    }
    return changes;
  }
  function apply(state,changes) {
    for(const [target,data] of changes) {
      if(target==='g'){for(const key of state.keys())if(key.startsWith('g.'))state.delete(key);}
      else state.set(target,data);
    }
    return state;
  }
  function fromScript(source) {
    const values=[...apply(new Map(),initializers(source)).values()];
    return {ids:[...new Set(values.flatMap(r=>r.ids))],signedOut:values.some(r=>r.signedOut)};
  }
  function read(document,isVisible) {
    const ids=new Set(),sources=new Set();let personalEntry=false,loginControl=false,signedOut=false;
    const allowed=e=>!e.closest(excluded);
    const add=(value,source)=>{const id=userId(value);if(id){ids.add(id);sources.add(source);}};
    const roots=new Set([...document.querySelectorAll(headers)].filter(e=>allowed(e)&&isVisible(e)));
    // The name itself is often a <span>; its own <li> contains the personal-center entry.
    for(const root of [...roots]) {
      const container=root.closest('li,.user-info,.navbar-user,.nav-user,.nav_user,.header-user');
      if(container&&allowed(container)&&isVisible(container))roots.add(container);
    }
    for(const root of roots) {
      for(const el of [root,...root.querySelectorAll(attributes.map(a=>`[${a}]`).join(','))]) {
        if(!allowed(el))continue;
        for(const attr of attributes)add(el.getAttribute(attr),'header');
      }
      for(const a of [root,...root.querySelectorAll('a[href]')]) {
        if(!a.matches('a[href]')||!allowed(a))continue;
        const u=buffUrl(a.getAttribute('href'));if(!u)continue;
        personalEntry||=/^\/user-center(?:\/|$)/.test(u.pathname);
        add(idFromUrl(u.href),'profile-link');
        loginControl||=isVisible(a)&&/^(?:登录|请登录|登录\s*[/／]\s*注册|Log in|Sign in)$/i.test((a.textContent||'').trim());
      }
      loginControl||=/^(?:登录|请登录|登录\s*[/／]\s*注册|Log in|Sign in)$/i.test((root.textContent||'').trim());
    }
    for(const root of [document.documentElement,document.body])if(root)add(root.getAttribute('data-current-user-id'),'document');
    const currentData=new Map();
    for(const script of document.querySelectorAll('script:not([src])')) {
      if(!allowed(script))continue;
      const type=(script.getAttribute('type')||'').toLowerCase();
      if(type&&!['text/javascript','application/javascript','module'].includes(type))continue;
      const value=script.textContent||'';
      let parsed=scriptCache.get(script);
      if(parsed?.value!==value){parsed={value,changes:initializers(value)};scriptCache.set(script,parsed);}
      apply(currentData,parsed.changes);
    }
    for(const data of currentData.values()){for(const id of data.ids)add(id,'current-user-data');signedOut||=data.signedOut;}
    const state=loginControl||signedOut?'logged_out':ids.size>1?'conflict':ids.size===1?'identified':'missing';
    return {state,accountId:state==='identified'?'buff:'+ids.values().next().value:null,personalEntry,sources:[...sources]};
  }
  function message(info) {
    if(info.state==='logged_out')return 'BUFF 页面显示未登录或会话已退出，请登录后回到商品页点击“继续核对”';
    if(info.state==='conflict')return 'BUFF 当前用户资料与个人区账号不一致，请刷新商品页后继续核对；已暂停购买';
    return (info.personalEntry?'已检测到 BUFF 个人中心入口，但未读到当前用户 ID。':'尚未读到 BUFF 当前用户 ID。')+'请刷新商品页后点击“继续核对”；仅有昵称或通用个人中心地址不能用于区分账号';
  }
  return {userId,idFromUrl,canonical,compatible,fromScript,read,message};
});
