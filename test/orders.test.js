"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createDatabase } = require("../server/database/database");
const { createOrderWithItems, OrderError } = require("../server/services/orderService");

const customer = () => ({ firstName: "Alex", lastName: "Example", email: "alex@example.test", address: "100 Synthetic Way", city: "City", state: "ST", zip: "00000" });
const input = (orderId="SYNTHETIC-ORDER",items=[{productId:1,quantity:2}]) => ({orderId,customer:customer(),items});
function fixture(t) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),"group9-stage4-"));
    const filename=path.join(directory,"synthetic.sqlite");
    const connections=[];
    t.after(async()=> {await Promise.all(connections.map(db=>db.closeAsync()));fs.rmSync(directory,{recursive:true});});
    return {filename,open(){const db=createDatabase({filename});connections.push(db);return db;}};
}
async function counts(db,orders,items) {
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Orders")).count,orders);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM OrderItems")).count,items);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM PaymentAuthorizations")).count,0);
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Settlements")).count,0);
}
const deferred=()=> {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test("order creation stores Pending order, server date, customer fields and historical item snapshot",async t=> {
    const db=fixture(t).open();
    const request=input(); request.orderId="  SYNTHETIC-ORDER  ";request.customer.firstName=" Alex ";
    const created=await createOrderWithItems(request,{database:db});
    assert.equal(created.orderId,"SYNTHETIC-ORDER");assert.equal(created.orderStatus,"Pending");
    assert.equal(created.totalCents,12998);assert.equal(created.orderTotal,129.98);
    assert.equal(new Date(created.orderDate).toISOString(),created.orderDate);
    assert.deepEqual(await db.getAsync("SELECT * FROM Orders"),{
        OrderID:"SYNTHETIC-ORDER",CustomerName:"Alex Example",CustomerEmail:"alex@example.test",ShippingAddress:"100 Synthetic Way",City:"City",State:"ST",Zip:"00000",OrderDate:created.orderDate,OrderTotal:129.98,OrderStatus:"Pending",
    });
    const item=await db.getAsync("SELECT * FROM OrderItems");
    assert.deepEqual(item,{OrderItemID:1,OrderID:"SYNTHETIC-ORDER",ProductID:1,ProductName:"Trail Backpack",UnitPriceCents:6499,Quantity:2});
    await counts(db,1,1);assert.deepEqual(await db.allAsync("PRAGMA foreign_key_check"),[]);
});

test("multiple product orders and exact cent totals are stored consistently",async t=> {
    const db=fixture(t).open();
    const created=await createOrderWithItems(input("MULTI",[{productId:1,quantity:2},{productId:2,quantity:3}]),{database:db});
    assert.equal(created.orderTotal,204.95);assert.equal(created.totalCents,20495);
    assert.deepEqual(await db.allAsync("SELECT ProductID,ProductName,UnitPriceCents,Quantity FROM OrderItems ORDER BY OrderItemID"),[
        {ProductID:1,ProductName:"Trail Backpack",UnitPriceCents:6499,Quantity:2},
        {ProductID:2,ProductName:"Insulated Bottle",UnitPriceCents:2499,Quantity:3},
    ]);
    await db.runAsync("UPDATE Products SET Price=0.10 WHERE ProductID=1");
    await db.runAsync("UPDATE Products SET Price=0.20 WHERE ProductID=2");
    assert.equal((await createOrderWithItems(input("CENTS",[{productId:1,quantity:1},{productId:2,quantity:1}]),{database:db})).orderTotal,0.3);
    assert.equal((await db.getAsync("SELECT OrderTotal FROM Orders WHERE OrderID='CENTS'")).OrderTotal,0.3);
});

test("duplicate IDs never overwrite an existing order, snapshots, customer or status",async t=> {
    const db=fixture(t).open();
    await createOrderWithItems(input(),{database:db});
    await db.runAsync("UPDATE Orders SET OrderStatus='Settled' WHERE OrderID='SYNTHETIC-ORDER'");
    const before=await db.getAsync("SELECT * FROM Orders");
    const beforeItems=await db.allAsync("SELECT * FROM OrderItems");
    const duplicate=input(" SYNTHETIC-ORDER ",[{productId:9999,quantity:1}]);duplicate.customer.firstName="Different";
    await assert.rejects(createOrderWithItems(duplicate,{database:db}),{code:"DUPLICATE_ORDER_ID",statusCode:409});
    assert.deepEqual(await db.getAsync("SELECT * FROM Orders"),before);
    assert.deepEqual(await db.allAsync("SELECT * FROM OrderItems"),beforeItems);
    await counts(db,1,1);
});

test("malformed order IDs and customer data fail before querying a database",async()=> {
    let calls=0;const database={withTransaction(){calls++;throw new Error("No database access expected");}};
    for(const orderId of [undefined,null,""," ",1,false]) {
        await assert.rejects(createOrderWithItems({...input(),orderId},{database}),{code:"INVALID_ORDER_ID"});
    }
    for(const value of [null,[],"customer",{}, {...customer(),firstName:" "},{...customer(),email:"invalid"},{...customer(),address:""},{...customer(),city:1},{...customer(),zip:null},{...customer(),cardNumber:"MUST-NOT-BE-STORED"}]) {
        await assert.rejects(createOrderWithItems({...input(),customer:value},{database}),{code:"INVALID_CUSTOMER"});
    }
    for(const value of [null,[],"order",{...input(),amount:0.01},{...input(),orderStatus:"Authorized"}]) {
        await assert.rejects(createOrderWithItems(value,{database}),{code:"INVALID_ORDER"});
    }
    let read=false;const getter={get orderId(){read=true;return "BAD";},customer:customer(),items:[{productId:1,quantity:1}]};
    await assert.rejects(createOrderWithItems(getter,{database}),{code:"INVALID_ORDER"});
    assert.equal(read,false);assert.equal(calls,0);
});

test("optional customer fields retain previous defaults without undefined names",async t=> {
    const db=fixture(t).open();const request=input();request.customer={firstName:"Alex",email:"alex@example.test",address:"Synthetic"};
    await createOrderWithItems(request,{database:db});
    assert.deepEqual(await db.getAsync("SELECT CustomerName,City,State,Zip FROM Orders"),{CustomerName:"Alex",City:"",State:"",Zip:""});
});

test("invalid carts and browser-supplied prices never create partial records",async t=> {
    const db=fixture(t).open();
    for(const items of [[],null,[{productId:1,quantity:0}],[{productId:"1",quantity:1}],[{productId:9999,quantity:1}],[{productId:1,quantity:1},{productId:1,quantity:2}],[{productId:1,quantity:1,Price:0.01}]]) {
        await assert.rejects(createOrderWithItems(input("INVALID",items),{database:db}));
        await counts(db,0,0);
    }
    for(const field of ["amount","orderTotal","total","totalCents","cardNumber","ccv"]) {
        await assert.rejects(createOrderWithItems({...input(),[field]:0.01},{database:db}),{code:"INVALID_ORDER"});
    }
    await counts(db,0,0);
});

test("failure on a later OrderItems insert rolls back order and all earlier items",async t=> {
    const db=fixture(t).open();
    await db.runAsync("CREATE TRIGGER RejectSecondItem BEFORE INSERT ON OrderItems WHEN NEW.ProductID=2 BEGIN SELECT RAISE(ABORT,'synthetic item failure'); END");
    await assert.rejects(createOrderWithItems(input("ROLLBACK",[{productId:1,quantity:1},{productId:2,quantity:1}]),{database:db}),{code:"SQLITE_CONSTRAINT"});
    await counts(db,0,0);
    await createOrderWithItems(input("RECOVERY"),{database:db});await counts(db,1,1);
});

test("order insert failures and ignored writes cannot report successful order creation",async t=> {
    const db=fixture(t).open();
    await db.runAsync("CREATE TRIGGER RejectOrder BEFORE INSERT ON Orders BEGIN SELECT RAISE(ABORT,'synthetic order failure'); END");
    await assert.rejects(createOrderWithItems(input(),{database:db}),{code:"SQLITE_CONSTRAINT"});await counts(db,0,0);
    await db.runAsync("DROP TRIGGER RejectOrder");
    await db.runAsync("CREATE TRIGGER IgnoreItem BEFORE INSERT ON OrderItems BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(createOrderWithItems(input(),{database:db}),{code:"ORDER_WRITE_FAILED",statusCode:500});await counts(db,0,0);
    await db.runAsync("DROP TRIGGER IgnoreItem");
    await db.runAsync("CREATE TRIGGER IgnoreOrder BEFORE INSERT ON Orders BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(createOrderWithItems(input(),{database:db}),{code:"ORDER_WRITE_FAILED",statusCode:500});await counts(db,0,0);
});

test("simultaneous duplicate requests on one connection create exactly one order",async t=> {
    const db=fixture(t).open();
    const results=await Promise.allSettled(Array.from({length:10},()=>createOrderWithItems(input("RACE"),{database:db})));
    assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
    const failures=results.filter(result=>result.status==="rejected");
    assert.equal(failures.length,9);assert.ok(failures.every(result=>result.reason.code==="DUPLICATE_ORDER_ID"));
    await counts(db,1,1);
});

test("simultaneous duplicate requests across independent connections remain atomic",async t=> {
    const f=fixture(t);const first=f.open();const second=f.open();await Promise.all([first.ready,second.ready]);
    const results=await Promise.allSettled([createOrderWithItems(input("CROSS-CONNECTION"),{database:first}),createOrderWithItems(input("CROSS-CONNECTION"),{database:second})]);
    assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
    assert.equal(results.find(result=>result.status==="rejected").reason.code,"DUPLICATE_ORDER_ID");
    await counts(first,1,1);
});

test("saved names and prices remain historical while later orders use current SQLite prices",async t=> {
    const db=fixture(t).open();
    const first=await createOrderWithItems(input("OLD"),{database:db});
    await db.runAsync("UPDATE Products SET Name='Changed catalog',Price=1,ImageURL='/changed.png' WHERE ProductID=1");
    const second=await createOrderWithItems(input("NEW"),{database:db});
    assert.equal(first.orderTotal,129.98);assert.equal(second.orderTotal,2);
    assert.deepEqual(await db.allAsync("SELECT OrderID,ProductName,UnitPriceCents,Quantity FROM OrderItems ORDER BY OrderItemID"),[
        {OrderID:"OLD",ProductName:"Trail Backpack",UnitPriceCents:6499,Quantity:2},
        {OrderID:"NEW",ProductName:"Changed catalog",UnitPriceCents:100,Quantity:2},
    ]);
    assert.equal((await db.getAsync("SELECT OrderTotal FROM Orders WHERE OrderID='OLD'")).OrderTotal,129.98);
});

test("order creation uses one transaction and can reuse a caller-owned scope without nesting",async t=> {
    const db=fixture(t).open();let transactions=0;
    const database={withTransaction(work){transactions++;return db.withTransaction(work);}};
    await createOrderWithItems(input("OWNED"),{database});assert.equal(transactions,1);
    await db.withTransaction(async tx=> {
        const order=await createOrderWithItems(input("SHARED"),{transaction:tx});
        assert.equal(order.orderTotal,129.98);
        assert.equal((await tx.get("SELECT OrderID FROM Orders WHERE OrderID=?",[order.orderId])).OrderID,"SHARED");
    });
    await assert.rejects(db.withTransaction(async tx=> {
        await createOrderWithItems(input("OUTER-ROLLBACK"),{transaction:tx});throw new Error("synthetic outer failure");
    }),/synthetic outer failure/);
    assert.equal(await db.getAsync("SELECT OrderID FROM Orders WHERE OrderID='OUTER-ROLLBACK'"),undefined);
    await counts(db,2,2);
});

test("input snapshots protect queued order IDs, customer data and cart quantities",async t=> {
    const db=fixture(t).open();const entered=deferred();const release=deferred();
    const blocking=db.withTransaction(async()=> {entered.resolve();await release.promise;});await entered.promise;
    const request=input("CAPTURED");const pending=createOrderWithItems(request,{database:db});
    request.orderId="MUTATED";request.customer.firstName="Mutated";request.items[0].quantity=999;request.items.push({productId:2,quantity:1});
    release.resolve();await blocking;const created=await pending;
    assert.equal(created.orderId,"CAPTURED");assert.equal(created.orderTotal,129.98);
    assert.equal((await db.getAsync("SELECT CustomerName FROM Orders")).CustomerName,"Alex Example");
    assert.equal((await db.getAsync("SELECT Quantity FROM OrderItems")).Quantity,2);await counts(db,1,1);
});

test("invalid database pricing, overflow and closed connections create no orders",async t=> {
    const db=fixture(t).open();
    await db.runAsync("UPDATE Products SET Price=1.005 WHERE ProductID=1");
    await assert.rejects(createOrderWithItems(input(),{database:db}),{code:"INVALID_PRODUCT_PRICE"});await counts(db,0,0);
    await db.runAsync("UPDATE Products SET Price=90071992547409.90 WHERE ProductID=1");
    await assert.rejects(createOrderWithItems(input(),{database:db}),{code:"CART_TOTAL_OVERFLOW"});await counts(db,0,0);
    await db.closeAsync();await assert.rejects(createOrderWithItems(input(),{database:db}),{code:"DB_CLOSED"});
});

test("integration options reject missing or conflicting transaction contexts",async()=> {
    for(const options of [null,[],{database:null},{database:{}},{transaction:null},{transaction:{}},{database:{},transaction:{get(){},all(){},run(){}}}]) {
        await assert.rejects(createOrderWithItems(input(),options),TypeError);
    }
});

test("IDs and customer text are stored literally with bound SQL parameters",async t=> {
    const db=fixture(t).open();const request=input("SYN-'\"); DROP TABLE Products; --");
    request.customer.lastName="O'Example <script>literal</script>";
    const result=await createOrderWithItems(request,{database:db});
    assert.equal((await db.getAsync("SELECT OrderID FROM Orders")).OrderID,result.orderId);
    assert.equal((await db.getAsync("SELECT CustomerName FROM Orders")).CustomerName,"Alex O'Example <script>literal</script>");
    assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM Products")).count,5);
});

test("zero-priced products create a zero-total Pending order without authorizing payment",async t=> {
    const db=fixture(t).open();await db.runAsync("UPDATE Products SET Price=0 WHERE ProductID=1");
    assert.equal((await createOrderWithItems(input(),{database:db})).orderTotal,0);await counts(db,1,1);
});

test("default helper is lazy and uses an explicit temporary DB_PATH when invoked",t=> {
    const f=fixture(t);
    const code=[
        'const assert=require("node:assert/strict");const fs=require("node:fs");',
        'const {createOrderWithItems}=require(process.argv[1]);const db=require(process.argv[2]);',
        '(async()=>{assert.equal(fs.existsSync(process.env.DB_PATH),false);',
        'const result=await createOrderWithItems({orderId:"SYNTHETIC-DEFAULT",customer:{firstName:"Synthetic",email:"synthetic@example.test",address:"Synthetic"},items:[{productId:1,quantity:1}]});',
        'assert.equal(result.orderTotal,64.99);assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM PaymentAuthorizations")).count,0);await db.closeAsync();',
        '})().catch(error=>{console.error(error);process.exitCode=1;});',
    ].join("\n");
    const result=spawnSync(process.execPath,["-e",code,path.resolve(__dirname,"../server/services/orderService.js"),path.resolve(__dirname,"../server/database/db.js")],{env:{...process.env,DB_PATH:f.filename},encoding:"utf8",timeout:5000});
    assert.equal(result.status,0,result.stderr);
    assert.equal(typeof OrderError,"function");
});
