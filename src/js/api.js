// Talking to the outside: the root daemon (HTTP on this TV) and webOS services (luna).

const API="http://127.0.0.1:8765";
const APP_DIR=decodeURIComponent(location.pathname.replace(/\/[^/]*$/,""));
const HBCHANNEL_EXEC="luna://org.webosbrew.hbchannel.service/exec";

async function api(method,path,body) {
	const res=await fetch(API+path,{
		method:method,
		headers:body?{"Content-Type":"application/json"}:undefined,
		body:body?JSON.stringify(body):undefined,
	});
	return res.json();
}

// The bridge object must be kept alive until it answers, or it can be garbage collected mid-call.
const bridges=new Set();

function luna(uri,params) {
	return new Promise((resolve) => {
		if(typeof PalmServiceBridge==="undefined"){
			resolve({returnValue:false,errorText:"Not running on webOS"});
			return;
		}
		const bridge=new PalmServiceBridge();
		bridges.add(bridge);
		bridge.onservicecallback=(msg) => {
			bridges.delete(bridge);
			try { resolve(JSON.parse(msg)); } catch(e) { resolve({returnValue:false,errorText:msg}); }
		};
		bridge.call(uri,JSON.stringify(params || {}));
	});
}

// Run one of our daemon/*.sh scripts as root through Homebrew Channel.
async function runroot(script) {
	const r=await luna(HBCHANNEL_EXEC,{command:"sh \""+APP_DIR+"/daemon/"+script+"\""});
	if(r.returnValue===false){
		toast("Homebrew Channel exec failed: "+(r.errorText || r.stderrString || "unknown error"));
		return false;
	}
	return true;
}

// ---- small DOM helpers shared by the other files
function el(tag,className,text) {
	const node=document.createElement(tag);
	if(className){ node.className=className; }
	if(text!==undefined && text!==null){ node.textContent=text; }
	return node;
}

// Only touch the DOM when the text really changed: every write costs a layout on the TV.
function settext(node,text) {
	if(node.textContent!==text){ node.textContent=text; }
}

let toasttimer=null;
function toast(msg) {
	const box=document.getElementById("toast");
	box.textContent=msg;
	box.classList.add("show");
	clearTimeout(toasttimer);
	toasttimer=setTimeout(() => box.classList.remove("show"),3500);
}
