// IR Binder screen: service status, live signals, bindings, and the learn/bind dialog.
// Kept light for the TV: polling stops while the app is in the background, the log only adds and removes the rows
// that changed, and lists are only rebuilt when their data changed.

const $=(id) => document.getElementById(id);

const STATUS_EVERY_MS=3000;
const EVENTS_EVERY_MS=500;
const LOG_ROWS=15;
const LEARN_MS=20000;

// ---- what a signal can be bound to
const btn=(label,name,repeat) => ({label:label,action:{type:"button",name:name},repeat:!!repeat});

const CATALOG={
	Power:[
		{label:"Power off TV",action:{type:"power",mode:"off"}},
		{label:"Screen off / on",action:{type:"power",mode:"screenToggle"}},
		{label:"Screen off",action:{type:"power",mode:"screenOff"}},
		{label:"Screen on",action:{type:"power",mode:"screenOn"}},
		btn("Power key","POWER"),
	],
	Numbers:["1","2","3","4","5","6","7","8","9","0"].map((n) => btn(n,n)).concat([btn("– (dash)","DASH"),btn("List","LIST")]),
	Volume:[
		{label:"Volume +",action:{type:"volume",dir:"up"},repeat:true},
		{label:"Volume –",action:{type:"volume",dir:"down"},repeat:true},
		{label:"Mute",action:{type:"volume",dir:"mute"}},
		btn("Channel +","CHANNELUP",true),
		btn("Channel –","CHANNELDOWN",true),
	],
	Navigation:[
		btn("Up","UP",true),btn("Down","DOWN",true),btn("Left","LEFT",true),btn("Right","RIGHT",true),
		btn("OK","ENTER"),btn("Back","BACK"),btn("Home","HOME"),btn("Exit","EXIT"),
		btn("Settings","MENU"),btn("Quick menu","QMENU"),btn("Info","INFO"),btn("Input","INPUT"),
	],
	Media:[
		btn("Play","PLAY"),btn("Pause","PAUSE"),btn("Stop","STOP"),
		btn("Fast forward","FASTFORWARD",true),btn("Rewind","REWIND",true),
		btn("Red","RED"),btn("Green","GREEN"),btn("Yellow","YELLOW"),btn("Blue","BLUE"),
	],
	Apps:null,      // listed from the TV
	Custom:null,    // a luna call or a shell command
};

function signaltext(s) {
	if(!s){ return ""; }
	const parts=[];
	if(s.keyName){ parts.push(s.keyName); }
	if(s.scan){ parts.push("scan "+s.scan); }
	return parts.join(" · ") || s.sig;
}

// ---- service status
let online=false;
let paused=false;

async function refreshstatus() {
	const wasonline=online;
	try {
		const s=await api("GET","/status");
		online=true;
		paused=s.paused;
		const readable=s.devices.filter((d) => !d.error);
		$("status").className="pill "+(paused?"paused":"on");
		settext($("status"),paused?"Service: paused":"Service: running");
		settext($("statustext"),"Listening on "+readable.length+" input device(s): "+(readable.map((d) => d.name).join(", ") || "none")+
			(s.uid!==0?" — not running as root, devices may be unreadable.":""));
		settext($("pausebtn"),paused?"Resume bindings":"Pause bindings");
		settext($("installbtn"),"Restart service");
	} catch(e) {
		online=false;
		$("status").className="pill off";
		settext($("status"),"Service: not running");
		settext($("statustext"),"The background service is not running. Install it to start detecting signals.");
		settext($("installbtn"),"Install & start service");
	}
	if(online && !wasonline){
		lasteventid=(await api("GET","/events?after=999999999").catch(() => ({last:0}))).last;
		refreshbindings();
	}
}

async function installservice() {
	toast("Starting service…");
	if(!await runroot("install.sh")){ return; }
	setTimeout(async () => {
		await refreshstatus();
		toast(online?"Service running. It will also start on boot.":"Service did not start. Check /tmp/irbindd.log");
	},2500);
}

async function uninstallservice() {
	if(!await runroot("uninstall.sh")){ return; }
	toast("Service stopped and autostart removed.");
	setTimeout(refreshstatus,1500);
}

async function togglepause() {
	if(!online){ toast("Service is not running."); return; }
	await api("POST","/pause",{paused:!paused});
	refreshstatus();
}

// ---- live log: new rows go on top, old ones fall off the bottom; nothing else is touched
let lasteventid=0;

async function pollevents() {
	if(!online){ return; }
	let r;
	try { r=await api("GET","/events?after="+lasteventid); } catch(e) { return; }
	if(!r.events.length){ return; }
	lasteventid=r.last;
	const log=$("log");
	const first=log.firstElementChild;
	if(first && first.classList.contains("muted")){ log.removeChild(first); }
	const rows=document.createDocumentFragment();
	r.events.slice(-LOG_ROWS).reverse().forEach((ev) => {
		const li=el("li");
		li.appendChild(el("span","time",new Date(ev.t).toLocaleTimeString()));
		li.appendChild(el("span","dev",ev.device));
		li.appendChild(el("span","key mono",signaltext(ev)+(ev.repeat?" (held)":"")));
		li.appendChild(el("span","bound",ev.bound?"→ "+ev.bound:""));
		rows.appendChild(li);
		if(ev.bound){ markhit(ev.sig); }
	});
	log.insertBefore(rows,log.firstChild);
	while(log.children.length>LOG_ROWS){ log.removeChild(log.lastChild); }
}

// ---- bindings list: rebuilt only when the data changed
let bindingsjson="";

async function refreshbindings() {
	if(!online){ return; }
	let r;
	try { r=await api("GET","/bindings"); } catch(e) { return; }
	const list=r.bindings.sort((a,b) => a.created-b.created);
	const json=JSON.stringify(list);
	if(json===bindingsjson){ return; }
	bindingsjson=json;

	const focusedsig=dpadfocus && dpadfocus.closest(".bindings li")?dpadfocus.closest("li").dataset.sig:null;
	const focusedrole=focusedsig?dpadfocus.dataset.role:null;
	const ul=$("bindings");
	const rows=document.createDocumentFragment();
	if(!list.length){
		rows.appendChild(el("li","muted","No bindings yet. Press \"Learn new signal\" to add one."));
	}
	list.forEach((b) => {
		const li=el("li");
		li.dataset.sig=b.sig;
		const sig=el("div","sig mono",signaltext(b.signal || {sig:b.sig}));
		sig.appendChild(el("small",null,b.signal?b.signal.device:b.sig));
		li.appendChild(sig);
		li.appendChild(el("div","label",b.label+(b.repeat?"  ⟳":"")));
		const test=el("button","small","Test");
		test.dataset.role="test";
		test.addEventListener("click",async () => {
			const res=await api("POST","/run",{action:b.action}).catch((e) => ({ok:false,error:e.message}));
			toast(res.ok?"Ran \""+b.label+"\"":"Failed: "+res.error);
		});
		const del=el("button","small ghost","Delete");
		del.dataset.role="delete";
		del.addEventListener("click",async () => {
			await api("DELETE","/bindings?sig="+encodeURIComponent(b.sig));
			toast("Removed \""+b.label+"\"");
			refreshbindings();
		});
		li.appendChild(test);
		li.appendChild(del);
		rows.appendChild(li);
	});
	ul.textContent="";
	ul.appendChild(rows);
	// keep the ring on the same row's button after a rebuild, or near where it was
	if(focusedsig){
		const again=ul.querySelector("li[data-sig=\""+CSS.escape(focusedsig)+"\"] [data-role=\""+focusedrole+"\"]");
		settle(again || ul.querySelector("button") || $("learnbtn"));
	}
}

const hittimers={};
function markhit(sig) {
	const li=$("bindings").querySelector("li[data-sig=\""+CSS.escape(sig)+"\"]");
	if(!li){ return; }
	li.classList.add("hit");
	clearTimeout(hittimers[sig]);
	hittimers[sig]=setTimeout(() => li.classList.remove("hit"),500);
}

// ---- the learn / bind dialog
let learning=false;
let captured=null;
let repeat=false;
let countdowntimer=null;
let activetab="Power";
let returnto=null;

function showdialog(step) {
	document.body.classList.toggle("modalopen",!!step);
	document.body.classList.toggle("waiting",step==="wait");
	document.body.classList.toggle("binding",step==="bind");
}

function closedialog() {
	learning=false;
	lockkeys(false);
	clearInterval(countdowntimer);
	showdialog(null);
	settle(returnto || $("learnbtn"));
}

async function startlearn() {
	if(!online){ toast("Start the service first."); return; }
	returnto=$("learnbtn");
	learning=true;
	lockkeys(true);
	showdialog("wait");
	let left=LEARN_MS/1000;
	settext($("countdown"),String(left));
	clearInterval(countdowntimer);
	countdowntimer=setInterval(() => settext($("countdown"),String(Math.max(--left,0))),1000);

	let r;
	try { r=await api("POST","/learn",{timeout:LEARN_MS}); } catch(e) { r={ok:false}; }
	clearInterval(countdowntimer);
	if(!learning){ return; }      // cancelled meanwhile
	learning=false;
	lockkeys(false,600);          // swallow the key-up and repeats of the captured press

	if(!r.ok){
		closedialog();
		toast(r.timeout?"No signal received.":"Learning cancelled.");
		return;
	}
	captured=r.signal;
	showbindstep();
}

function cancellearn() {
	api("POST","/learn/cancel").catch(() => {});
	closedialog();
}

function showbindstep() {
	showdialog("bind");
	settext($("siglabel"),signaltext(captured));
	settext($("siginfo"),"From \""+captured.device+"\". Choose what this button should do:");
	setrepeat(false);
	const tabs=$("tabs");
	tabs.textContent="";
	Object.keys(CATALOG).forEach((name) => {
		const tab=el("button",null,name);
		tab.dataset.tab=name;
		tab.addEventListener("click",() => selecttab(name,true));
		tabs.appendChild(tab);
	});
	selecttab(activetab,true);
}

function setrepeat(on) {
	repeat=on;
	settext($("repeatbtn"),"Repeat while held: "+(on?"on":"off"));
}

async function selecttab(name,ringontab) {
	activetab=name;
	Array.prototype.forEach.call($("tabs").children,(tab) => tab.classList.toggle("on",tab.dataset.tab===name));
	const box=$("choices");
	box.textContent="";
	if(name==="Apps"){
		box.appendChild(el("p","muted","Loading apps…"));
		const r=await api("GET","/apps").catch(() => ({ok:false,error:"service unreachable"}));
		if(activetab!=="Apps"){ return; }
		box.textContent="";
		if(!r.ok){
			box.appendChild(el("p","muted","Could not list apps: "+r.error));
		} else {
			const items=document.createDocumentFragment();
			r.apps.forEach((a) => items.appendChild(choicebutton({label:"Open "+a.title,action:{type:"launch",id:a.id}},a.title)));
			box.appendChild(items);
		}
	} else if(name==="Custom"){
		rendercustom(box);
	} else {
		const items=document.createDocumentFragment();
		CATALOG[name].forEach((c) => items.appendChild(choicebutton(c)));
		box.appendChild(items);
	}
	const tab=$("tabs").querySelector("[data-tab=\""+name+"\"]");
	setfocus(ringontab?tab:box.querySelector("button, input") || tab);
}

function choicebutton(choice,text) {
	const b=el("button",null,text || choice.label);
	b.addEventListener("click",() => savebinding(choice.label,choice.action,repeat || !!choice.repeat));
	return b;
}

function rendercustom(box) {
	const uri=el("input","mono wide");
	uri.placeholder="luna://com.webos.service.../method";
	const params=el("input","mono mid");
	params.placeholder="{\"param\": \"value\"}";
	params.value="{}";
	const saveluna=el("button",null,"Bind luna call");
	saveluna.addEventListener("click",() => {
		let p;
		try { p=JSON.parse(params.value || "{}"); } catch(e) { toast("Params must be valid JSON"); return; }
		if(!/^luna:\/\//.test(uri.value)){ toast("URI must start with luna://"); return; }
		savebinding("Luna: "+uri.value.replace("luna://",""),{type:"luna",uri:uri.value,params:p},repeat);
	});
	const cmd=el("input","mono wide");
	cmd.placeholder="shell command (runs as root)";
	const savecmd=el("button",null,"Bind shell command");
	savecmd.addEventListener("click",() => {
		if(!cmd.value.trim()){ toast("Enter a command"); return; }
		savebinding("Shell: "+cmd.value.slice(0,40),{type:"shell",command:cmd.value},repeat);
	});
	[uri,params,saveluna,cmd,savecmd].forEach((node) => box.appendChild(node));
}

async function savebinding(label,action,rep) {
	const r=await api("POST","/bindings",{sig:captured.sig,label:label,action:action,repeat:rep,signal:captured})
		.catch((e) => ({ok:false,error:e.message}));
	closedialog();
	toast(r.ok?"Bound "+signaltext(captured)+" → "+label:"Save failed: "+r.error);
	refreshbindings();
}

// ---- remote control hooks for dpad.js
dpadcontext=() => {
	if(document.body.classList.contains("binding")){ return within($("stepbind"),"button, input"); }
	if(document.body.classList.contains("waiting")){ return within($("stepwait"),"button"); }
	return within($("page"),"button");
};

dpadback=() => {
	if(document.body.classList.contains("modalopen")){ cancellearn(); }
	else { window.close(); }
};

// ---- polling, paused while the app is in the background
let pollrun=0;     // bumped on every start/stop, so a request still in flight can't start a second loop

function loop(fn,ms,run) {
	const tick=async () => {
		await fn();
		if(run===pollrun && !document.hidden){ setTimeout(tick,ms); }
	};
	return tick;
}

function startpolling() {
	const run=++pollrun;
	loop(refreshstatus,STATUS_EVERY_MS,run)();
	loop(pollevents,EVENTS_EVERY_MS,run)();
}

function stoppolling() {
	pollrun++;
}

document.addEventListener("visibilitychange",() => {
	if(document.hidden){ stoppolling(); }
	else { startpolling(); refreshbindings(); }
});

// ---- start
$("installbtn").addEventListener("click",installservice);
$("uninstallbtn").addEventListener("click",uninstallservice);
$("pausebtn").addEventListener("click",togglepause);
$("learnbtn").addEventListener("click",startlearn);
$("cancellearnbtn").addEventListener("click",cancellearn);
$("cancelbindbtn").addEventListener("click",closedialog);
$("repeatbtn").addEventListener("click",() => setrepeat(!repeat));

(async function start() {
	await refreshstatus();
	setfocus(online?$("learnbtn"):$("installbtn"));
	startpolling();
})();
