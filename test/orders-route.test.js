"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const vm=require("node:vm");
const {createDatabase}=require("../server/database/database");
const service=require("../server/services/orderService");
const pricing=require("../server/services/pricingService");
const queries=require("../server/services/orderQueryService");
const source=fs.readFileSync(path.join(__dirname,"../server/routes/orders.js"),"utf8");
const payload=(orderId="SYNTHETIC-API")=>({orderId,customer:{firstName:"Alex",lastName:"Example",email:"alex@example.test",address:"Synthetic"},items:[{productId:1,quantity:2}]});
function fixture(t){
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),"group9-order-route-"));
    const db=createDatabase({filename:path.join(directory,"synthetic.sqlite")});
    t.after(async()=>{await db.closeAsync();fs.rmSync(directory,{recursive:true});});return db;
}
function handlers(db){
    const routes={};
    const router={post(path,fn){routes.post=fn;},get(path,fn){routes[path === "/:id" ? "detail" : "get"]=fn;}};
    const context={module:{exports:{}},require(name){
        if(name==="express")return {Router:()=>router};
        if(name==="../database/db")return db;
        if(name==="../services/orderService")return service;
        if(name==="../services/pricingService")return pricing;
        if(name==="../services/orderQueryService")return queries;
        throw new Error("Unexpected route dependency: "+name);
    }};
    vm.runInNewContext(source,context);
    return async(method,value)=>new Promise((resolve,reject)=>{
        let status=200;
        const res={status(code){status=code;return this;},json(body){resolve({status,body:JSON.parse(JSON.stringify(body))});}};
        const req=method==="post"?{body:value}:method==="detail"?{params:{id:value}}:{query:value};
        try{Promise.resolve(routes[method](req,res)).catch(reject);}catch(error){reject(error);}
    });
}

test("POST orders returns existing success fields with an authoritative numeric total",async t=>{
    const db=fixture(t);const request=handlers(db);
    assert.deepEqual(await request("post",payload()),{status:201,body:{success:true,message:"Order created successfully.",orderId:"SYNTHETIC-API",orderTotal:129.98,orderStatus:"Pending"}});
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count,1);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM PaymentAuthorizations")).count,0);
});

test("POST duplicate IDs return HTTP 409 and preserve the original record",async t=>{
    const db=fixture(t);const request=handlers(db);
    await request("post",payload());const before=await db.getAsync("SELECT * FROM Orders");
    const modified=payload();modified.customer.firstName="Different";
    const result=await request("post",modified);
    assert.equal(result.status,409);assert.equal(result.body.success,false);assert.match(result.body.message,/already exists/);
    assert.deepEqual(await db.getAsync("SELECT * FROM Orders"),before);
});

test("simultaneous POST handlers produce one 201 and one 409",async t=>{
    const db=fixture(t);const request=handlers(db);
    const results=await Promise.all([request("post",payload("API-RACE")),request("post",payload("API-RACE"))]);
    assert.deepEqual(results.map(result=>result.status).sort(),[201,409]);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count,1);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count,1);
});

test("POST rejects malformed requests, amount-only legacy requests and browser tampering",async t=>{
    const db=fixture(t);const request=handlers(db);
    const legacy=payload();delete legacy.items;legacy.amount=0.01;
    for(const body of [undefined,null,[],legacy,{...payload(),amount:0.01},{...payload(),orderTotal:0.01},{...payload(),orderId:" "},{...payload(),items:[]},{...payload(),items:[{productId:1,quantity:1,Price:0.01}]},{...payload(),items:[{productId:1,quantity:0}]},{...payload(),items:[{productId:1,quantity:1},{productId:1,quantity:1}]}]){
        const result=await request("post",body);assert.equal(result.status,400);assert.equal(result.body.success,false);
    }
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count,0);
});

test("POST unknown product returns 404; database price errors return 500 without partial orders",async t=>{
    const db=fixture(t);const request=handlers(db);const unknown=payload();unknown.items=[{productId:9999,quantity:1}];
    assert.equal((await request("post",unknown)).status,404);
    await db.runAsync("UPDATE Products SET Price='invalid' WHERE ProductID=1");
    const result=await request("post",payload());assert.equal(result.status,500);assert.equal(result.body.success,false);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count,0);
});

test("unrelated SQLite constraints return 500 rather than duplicate 409 and hide SQL error detail",async t=>{
    const db=fixture(t);const request=handlers(db);
    await db.runAsync("CREATE TRIGGER RejectItem BEFORE INSERT ON OrderItems BEGIN SELECT RAISE(ABORT,'synthetic internal detail'); END");
    const result=await request("post",payload());
    assert.deepEqual(result,{status:500,body:{success:false,message:"Failed to create order."}});
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count,0);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count,0);
});

test("GET orders returns the safe collection field names",async t=>{
    const db=fixture(t);const request=handlers(db);
    await request("post",payload());
    const result=await request("get",{});
    assert.deepEqual(Object.keys(result.body.orders[0]).sort(),[
        "OrderID","CustomerName","CustomerEmail","ShippingAddress","City","State","Zip",
        "OrderDate","OrderTotal","OrderStatus","HasAuthorizationToken","AuthorizationAmount",
        "TransactionDateTime","AuthExpirationDate","AuthorizationResult","CardType","CardLast4"
    ].sort());
});

test("GET orders exposes only token availability, not tokens or failure reasons",async t=>{
    const db=fixture(t);const request=handlers(db);
    await request("post",payload("SECRET-ORDER"));
    await db.runAsync("INSERT INTO PaymentAuthorizations (OrderID,AuthorizationToken,AuthorizationAmount,TransactionDateTime,AuthorizationResult,FailureReason) VALUES ('SECRET-ORDER','SYNTHETIC-PRIVATE-TOKEN',10,'2030-01-01','Success','SYNTHETIC-PRIVATE-REASON')");
    const result=await request("get",{});const row=result.body.orders[0];
    assert.equal(row.HasAuthorizationToken,true);
    assert.equal(Object.hasOwn(row,"AuthorizationToken"),false);
    assert.equal(Object.hasOwn(row,"FailureReason"),false);
    assert.doesNotMatch(JSON.stringify(result.body),/SYNTHETIC-PRIVATE-(TOKEN|REASON)|CardNumber|CVV/);
    await db.runAsync("UPDATE PaymentAuthorizations SET AuthorizationToken='' WHERE OrderID='SECRET-ORDER'");
    assert.equal((await request("get",{})).body.orders[0].HasAuthorizationToken,false);
});

test("GET retains envelope, PascalCase fields and combined search/status/order-date sorting",async t=>{
    const db=fixture(t);const request=handlers(db);
    for(const [id,name,email]of[["ALPHA","Alice","alice@example.test"],["BETA","Bob","bob@example.test"],["GAMMA","Alice","other@example.test"]]){
        const body=payload(id);body.customer.firstName=name;body.customer.email=email;await request("post",body);
    }
    await db.runAsync("UPDATE Orders SET OrderDate='2030-01-01T00:00:00Z' WHERE OrderID='ALPHA'");
    await db.runAsync("UPDATE Orders SET OrderDate='2030-01-02T00:00:00Z' WHERE OrderID='BETA'");
    await db.runAsync("UPDATE Orders SET OrderDate='2030-01-03T00:00:00Z',OrderStatus='Authorized' WHERE OrderID='GAMMA'");
    const all=await request("get",{});
    assert.equal(all.status,200);assert.equal(all.body.success,true);assert.equal(all.body.count,3);
    assert.deepEqual(all.body.orders.map(order=>order.OrderID),["GAMMA","BETA","ALPHA"]);
    assert.equal(all.body.orders[0].OrderTotal,129.98);assert.equal(all.body.orders[0].HasAuthorizationToken,false);
    assert.equal(all.body.orders[0].AuthExpirationDate,null);
    assert.deepEqual((await request("get",{search:"Alice",sort:"oldest"})).body.orders.map(order=>order.OrderID),["ALPHA","GAMMA"]);
    assert.deepEqual((await request("get",{status:"Pending",search:"alice@example.test",sort:"oldest"})).body.orders.map(order=>order.OrderID),["ALPHA"]);
    assert.deepEqual((await request("get",{status:"Authorized",search:"GAM",sort:"newest"})).body.orders.map(order=>order.OrderID),["GAMMA"]);
});


test("GET collection counts unique orders and uses the highest AuthorizationID",async t=>{
    const db=fixture(t);const request=handlers(db);
    await request("post",payload("MULTIPLE"));await request("post",payload("NO-AUTH"));
    for(const [amount,date,result]of[[129.98,"2099-01-01","Success"],[80,"2020-01-01","Declined"]]){
        await db.runAsync("INSERT INTO PaymentAuthorizations (OrderID,AuthorizationToken,AuthorizationAmount,TransactionDateTime,AuthExpirationDate,AuthorizationResult) VALUES ('MULTIPLE',NULL,?,?,?,?)",[amount,date,"2030-01-08",result]);
    }
    const response=await request("get",{});
    assert.equal(response.status,200);assert.equal(response.body.count,2);
    const row=response.body.orders.find(row=>row.OrderID==="MULTIPLE");
    assert.equal(row.AuthorizationAmount,80);assert.equal(row.AuthorizationResult,"Declined");
    assert.equal(response.body.orders.find(row=>row.OrderID==="NO-AUTH").AuthorizationAmount,null);
});

test("GET detail returns a PascalCase order with snapshots and nullable authorization",async t=>{
    const db=fixture(t);const request=handlers(db);await request("post",payload("DETAIL"));
    const response=await request("detail","DETAIL");
    assert.equal(response.status,200);assert.deepEqual(Object.keys(response.body),["success","order"]);
    assert.equal(response.body.success,true);assert.equal(response.body.order.OrderID,"DETAIL");
    assert.equal(response.body.order.OrderTotal,129.98);assert.equal(response.body.order.OrderStatus,"Pending");
    assert.deepEqual(response.body.order.Items,[{OrderItemID:1,OrderID:"DETAIL",ProductID:1,ProductName:"Trail Backpack",UnitPriceCents:6499,Quantity:2}]);
    assert.equal(response.body.order.LatestAuthorization,null);assert.deepEqual(response.body.order.Settlements,[]);
});

test("GET detail includes latest authorized amount, expiration and all settlements without token or card data",async t=>{
    const db=fixture(t);const request=handlers(db);await request("post",payload("AUTH-DETAIL"));
    for(const [amount,date]of[[129.98,"2099-01-01"],[100,"2020-01-01"]]){
        await db.runAsync("INSERT INTO PaymentAuthorizations (OrderID,AuthorizationToken,AuthorizationAmount,TransactionDateTime,AuthExpirationDate,AuthorizationResult,CardType,CardLast4,FailureReason) VALUES ('AUTH-DETAIL','SYNTHETIC-SECRET',?,?,?,'Success','synthetic','0000','SYNTHETIC-SECRET')",[amount,date,"2030-01-08T12:00:00Z"]);
    }
    for(let i=0;i<2;i++)await db.runAsync("INSERT INTO Settlements (OrderID,FinalShipmentAmount,SettlementDate,SettlementResult) VALUES ('AUTH-DETAIL',75,'2030-01-02','Success')");
    const response=await request("detail","AUTH-DETAIL");
    assert.equal(response.status,200);
    assert.deepEqual(response.body.order.LatestAuthorization,{AuthorizationID:2,AuthorizationAmount:100,TransactionDateTime:"2020-01-01",AuthExpirationDate:"2030-01-08T12:00:00Z",AuthorizationResult:"Success"});
    assert.deepEqual(response.body.order.Settlements.map(row=>row.SettlementID),[2,1]);
    assert.doesNotMatch(JSON.stringify(response.body),/SYNTHETIC-SECRET|AuthorizationToken|CardType|CardLast4|FailureReason|CVV|CardNumber/);
});

test("GET historical details return an empty Items array without inventing or writing items",async t=>{
    const db=fixture(t);const request=handlers(db);
    await db.runAsync("INSERT INTO Orders VALUES ('HISTORICAL','Alex','alex@example.test','Synthetic','','','','2030-01-01',47.89,'Settled')");
    const response=await request("detail","HISTORICAL");
    assert.equal(response.status,200);assert.deepEqual(response.body.order.Items,[]);
    assert.equal(response.body.order.OrderTotal,47.89);assert.equal(response.body.order.LatestAuthorization,null);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count,0);
});

test("GET unknown details return 404; missing or blank IDs return 400 in the detail handler",async t=>{
    const db=fixture(t);const request=handlers(db);
    assert.deepEqual(await request("detail","MISSING"),{status:404,body:{success:false,message:"Order not found."}});
    for(const id of [undefined,"", "   "])assert.deepEqual(await request("detail",id),{status:400,body:{success:false,message:"A nonblank Order ID is required."}});
    assert.deepEqual(await request("get",{}),{status:200,body:{success:true,count:0,orders:[]}});
});

test("GET invalid structured query parameters return a safe HTTP 400",async t=>{
    const db=fixture(t);const request=handlers(db);
    for(const query of [{status:["Pending","Settled"]},{search:{}},{sort:["newest"]}]){
        const response=await request("get",query);assert.equal(response.status,400);assert.equal(response.body.success,false);
    }
});

test("GET database failures return generic HTTP 500 responses without database details",async t=>{
    const db=fixture(t);const request=handlers(db);await db.ready;await db.closeAsync();
    assert.deepEqual(await request("get",{}),{status:500,body:{success:false,message:"Failed to retrieve orders."}});
    assert.deepEqual(await request("detail","ANY"),{status:500,body:{success:false,message:"Failed to retrieve order details."}});
});

test("detail failures in each related-table query return 500 instead of partial success",async t=>{
    for(const table of ["OrderItems","PaymentAuthorizations","Settlements"]){
        const db=fixture(t);const request=handlers(db);await request("post",payload("BROKEN"));
        await db.runAsync(`DROP TABLE ${table}`);
        assert.deepEqual(await request("detail","BROKEN"),{status:500,body:{success:false,message:"Failed to retrieve order details."}});
        assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count,1);
    }
});


test("real Express router preserves collection URLs and decodes detail IDs without starting a server",async t=>{
    const db=fixture(t);
    const id="URL /? & '";
    await service.createOrderWithItems(payload(id),{database:db});
    const context={module:{exports:{}},require(name){
        if(name==="express")return require("express");
        if(name==="../database/db")return db;
        if(name==="../services/orderService")return service;
        if(name==="../services/pricingService")return pricing;
        if(name==="../services/orderQueryService")return queries;
        throw new Error("Unexpected route dependency: "+name);
    }};
    // Compile in this realm so Express sees native Promises from async handlers.
    // Dependencies remain injected; no default database or application server is opened.
    vm.compileFunction(source,["require","module"])(context.require,context.module);
    const router=context.module.exports;
    const request=url=>new Promise((resolve,reject)=>{
        const req={method:"GET",url,query:{}};
        let status=200;
        const res={status(code){status=code;return this;},json(body){resolve({status,body:JSON.parse(JSON.stringify(body))});}};
        router.handle(req,res,error=>error?reject(error):reject(new Error("No route matched")));
    });
    for(const url of ["/","/?status=&search=&sort=newest"]){
        const response=await request(url);
        assert.equal(response.status,200);assert.equal(response.body.count,1);
    }
    const detail=await request("/"+encodeURIComponent(id));
    assert.equal(detail.status,200);assert.equal(detail.body.order.OrderID,id);
    assert.equal((await request("/MISSING")).status,404);
    assert.equal((await request("/%20%20")).status,400);
});
