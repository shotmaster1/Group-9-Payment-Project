"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createDatabase } = require("../server/database/database");
const { priceCart, MAX_QUANTITY, MAX_CART_ITEMS } = require("../server/services/pricingService");

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),"group9-stage3-"));
    const filename = path.join(directory,"synthetic.sqlite");
    const db = createDatabase({filename});
    t.after(async()=> { await db.closeAsync(); fs.rmSync(directory,{recursive:true}); });
    return {db,filename};
}
const deferred = () => { let resolve; const promise = new Promise(done=> {resolve=done;}); return {promise,resolve}; };
const hash = filename=> createHash("sha256").update(fs.readFileSync(filename)).digest("hex");

test("single and multiple products use only SQLite prices and return cent snapshots plus numeric dollars", async t=> {
    const {db} = fixture(t);
    assert.deepEqual(await priceCart([{productId:1,quantity:2}],{database:db}), {
        items:[{productId:1,productName:"Trail Backpack",quantity:2,unitPriceCents:6499,lineTotalCents:12998}],
        totalCents:12998,orderTotal:129.98,
    });
    const result = await priceCart([{productId:2,quantity:3},{productId:1,quantity:2}],{database:db});
    assert.equal(result.totalCents,20495); assert.equal(result.orderTotal,204.95);
    assert.equal(typeof result.orderTotal,"number");
    assert.deepEqual(result.items.map(item=>item.productId),[2,1]);
    assert.equal(result.items[0].lineTotalCents,7497);
    assert.doesNotThrow(()=>JSON.stringify(result));
});

test("cart structure validation rejects empty, oversized, sparse and malformed carts before database use", async()=> {
    let calls=0;
    const database={withTransaction(){calls++; throw new Error("Must not query malformed input");}};
    for (const items of [undefined,null,{},"cart",0,[],new Array(1),[{productId:1,quantity:1},,],Array(MAX_CART_ITEMS+1).fill({productId:1,quantity:1})]) {
        await assert.rejects(priceCart(items,{database}));
    }
    for (const item of [null,undefined,1,"item",[],new Date(),{}, {productId:1},{quantity:1},{ProductID:1,quantity:1}]) {
        await assert.rejects(priceCart([item],{database}),{code:"INVALID_CART_ITEM"});
    }
    assert.equal(calls,0);
});

test("product IDs must be positive safe integer Numbers and unknown IDs fail without fallback", async t=> {
    const {db}=fixture(t);
    for (const productId of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,"1","1) OR 1=1",null,true,1n]) {
        await assert.rejects(priceCart([{productId,quantity:1}],{database:db}),{code:"INVALID_PRODUCT_ID"});
    }
    await assert.rejects(priceCart([{productId:9999,quantity:1}],{database:db}),{code:"PRODUCT_NOT_FOUND",productId:9999});
});

test("quantity limits reject fractional, zero, negative, excessive and coerced values", async t=> {
    const {db}=fixture(t);
    for (const quantity of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,MAX_QUANTITY+1,"1",null,true,1n]) {
        await assert.rejects(priceCart([{productId:1,quantity}],{database:db}),{code:"INVALID_QUANTITY"});
    }
    await db.runAsync("UPDATE Products SET Price=0.01 WHERE ProductID=1");
    const result=await priceCart([{productId:1,quantity:MAX_QUANTITY}],{database:db});
    assert.equal(result.totalCents,999); assert.equal(result.orderTotal,9.99);
});

test("duplicate products are rejected rather than consolidated or priced twice", async t=> {
    const {db}=fixture(t);
    await assert.rejects(priceCart([{productId:1,quantity:1},{productId:1,quantity:2}],{database:db}),{code:"DUPLICATE_PRODUCT",productId:1});
});

test("browser prices, amounts, totals and product snapshots cannot override authoritative values", async t=> {
    const {db}=fixture(t);
    for (const field of ["Price","price","amount","total","orderTotal","unitPrice","unitPriceCents","lineTotalCents","productName"]) {
        await assert.rejects(priceCart([{productId:1,quantity:1,[field]:0.01}],{database:db}),{code:"INVALID_CART_ITEM"});
    }
    await assert.rejects(priceCart({items:[{productId:1,quantity:1}],amount:0.01},{database:db}),{code:"INVALID_CART"});
    const item={productId:1,quantity:1}; item[Symbol("price")]=0;
    await assert.rejects(priceCart([item],{database:db}),{code:"INVALID_CART_ITEM"});
    let getterRead=false;
    const getterItem={get productId(){getterRead=true;return 1;},quantity:1};
    await assert.rejects(priceCart([getterItem],{database:db}),{code:"INVALID_CART_ITEM"});
    assert.equal(getterRead,false);
    assert.equal((await priceCart([{productId:1,quantity:1}],{database:db})).orderTotal,64.99);
});

test("decimal database prices sum and multiply to exact cents", async t=> {
    const {db}=fixture(t);
    await db.runAsync("UPDATE Products SET Price=0.10 WHERE ProductID=1");
    await db.runAsync("UPDATE Products SET Price=0.20 WHERE ProductID=2");
    assert.equal((await priceCart([{productId:1,quantity:1},{productId:2,quantity:1}],{database:db})).orderTotal,0.3);
    await db.runAsync("UPDATE Products SET Price=0.57 WHERE ProductID=1");
    const result=await priceCart([{productId:1,quantity:3}],{database:db});
    assert.equal(result.items[0].unitPriceCents,57);
    assert.equal(result.totalCents,171); assert.equal(result.orderTotal,1.71);
});

test("invalid SQLite prices fail safely instead of rounding or substituting a price", async t=> {
    const {db}=fixture(t);
    for (const price of [-0.01,"free","",1.005,0.1+0.2,Infinity,Buffer.from("not a price"),1e100]) {
        await db.runAsync("UPDATE Products SET Price=? WHERE ProductID=1",[price]);
        await assert.rejects(priceCart([{productId:1,quantity:1}],{database:db}),{code:"INVALID_PRODUCT_PRICE",productId:1});
    }
    await assert.rejects(db.runAsync("UPDATE Products SET Price=NULL WHERE ProductID=1"),{code:"SQLITE_CONSTRAINT"});
    await db.runAsync("UPDATE Products SET Price=1.23 WHERE ProductID=1");
    assert.equal((await priceCart([{productId:1,quantity:1}],{database:db})).orderTotal,1.23);
});

test("unusable product names cannot become invalid historical snapshots", async t=> {
    const {db}=fixture(t);
    await db.runAsync("UPDATE Products SET Name='   ' WHERE ProductID=1");
    await assert.rejects(priceCart([{productId:1,quantity:1}],{database:db}),{code:"INVALID_PRODUCT_NAME"});
});

test("zero-price products remain valid under the Stage 2 schema", async t=> {
    const {db}=fixture(t); await db.runAsync("UPDATE Products SET Price=0 WHERE ProductID=1");
    const priced=await priceCart([{productId:1,quantity:3}],{database:db});
    assert.equal(priced.orderTotal,0); assert.equal(priced.totalCents,0); assert.equal(priced.items[0].unitPriceCents,0);
});

test("cart line multiplication, total addition and numeric-dollar precision loss reject overflow", async t=> {
    const {db}=fixture(t);
    await db.runAsync("UPDATE Products SET Price=90071992547409.90 WHERE ProductID=1");
    await assert.rejects(priceCart([{productId:1,quantity:2}],{database:db}),{code:"CART_TOTAL_OVERFLOW"});
    await db.runAsync("UPDATE Products SET Price=1 WHERE ProductID=2");
    await assert.rejects(priceCart([{productId:1,quantity:1},{productId:2,quantity:1}],{database:db}),{code:"CART_TOTAL_OVERFLOW"});
    await db.runAsync("UPDATE Products SET Price=0.01 WHERE ProductID=2");
    await assert.rejects(priceCart([{productId:1,quantity:1},{productId:2,quantity:1}],{database:db}),{code:"CART_TOTAL_OVERFLOW"});
});

test("maximum cart size is accepted and prices every distinct product", async t=> {
    const {db}=fixture(t);
    await db.withTransaction(async tx=> {
        await tx.run("UPDATE Products SET Price=0.01");
        for (let i=6;i<=MAX_CART_ITEMS;i++) await tx.run("INSERT INTO Products(ProductID,Name,Price,ImageURL) VALUES (?, ?, 0.01, ?)",[i,"Synthetic product "+i,"/synthetic.png"]);
    });
    const result=await priceCart(Array.from({length:MAX_CART_ITEMS},(_,i)=>({productId:i+1,quantity:1})),{database:db});
    assert.equal(result.items.length,100); assert.equal(result.totalCents,100); assert.equal(result.orderTotal,1);
});

test("pricing is read-only and does not change products, PNG paths, schema or order records", async t=> {
    const {db,filename}=fixture(t); await db.ready;
    const before=hash(filename);
    await priceCart([{productId:1,quantity:2},{productId:2,quantity:1}],{database:db});
    await assert.rejects(priceCart([{productId:9999,quantity:1}],{database:db}),{code:"PRODUCT_NOT_FOUND"});
    assert.equal(hash(filename),before);
    assert.equal((await db.getAsync("PRAGMA user_version")).user_version,2);
    for (const name of ["Orders","OrderItems","PaymentAuthorizations","Settlements"]) {
        assert.equal((await db.getAsync("SELECT COUNT(*) AS count FROM "+name)).count,0);
    }
    assert.deepEqual(await db.allAsync("SELECT ImageURL FROM Products ORDER BY ProductID"),Array.from({length:5},(_,i)=>({ImageURL:"/img/p"+(i+1)+".png"})));
});

test("pricing composes with an existing transaction and uses one bound product query", async t=> {
    const {db}=fixture(t);
    await db.withTransaction(async tx=> {
        let queries=0;
        const priced=await priceCart([{productId:1,quantity:2},{productId:2,quantity:1}],{transaction:{all(sql,params){
            queries++; assert.match(sql,/ProductID IN \(\?, \?\)/); assert.deepEqual(params,[1,2]); return tx.all(sql,params);
        }}});
        assert.equal(queries,1); assert.equal(priced.orderTotal,154.97);
        await assert.rejects(priceCart([{productId:1,quantity:1}],{database:db}),{code:"DB_TRANSACTION_CONTEXT"});
    });
});

test("input snapshots remain stable while pricing is queued behind another transaction", async t=> {
    const {db}=fixture(t); const entered=deferred(); const release=deferred();
    const blocking=db.withTransaction(async()=> {entered.resolve();await release.promise;});
    await entered.promise;
    const input=[{productId:1,quantity:1}]; const pending=priceCart(input,{database:db});
    input[0].productId=2; input[0].quantity=999; input.push({productId:3,quantity:1});
    release.resolve(); await blocking;
    const result=await pending;
    assert.deepEqual(result.items,[{productId:1,productName:"Trail Backpack",quantity:1,unitPriceCents:6499,lineTotalCents:6499}]);
});

test("returned snapshots fit OrderItems and stay unchanged after catalog edits", async t=> {
    const {db}=fixture(t);
    await db.runAsync("INSERT INTO Orders VALUES ('SYNTHETIC-PRICING','Synthetic','synthetic@example.test','Synthetic','City','ST','00000','2031-01-01',129.98,'Pending')");
    const original=await db.withTransaction(async tx=> {
        const priced=await priceCart([{productId:1,quantity:2}],{transaction:tx});
        const item=priced.items[0];
        await tx.run("INSERT INTO OrderItems(OrderID,ProductID,ProductName,UnitPriceCents,Quantity) VALUES (?, ?, ?, ?, ?)",["SYNTHETIC-PRICING",item.productId,item.productName,item.unitPriceCents,item.quantity]);
        return priced;
    });
    await db.runAsync("UPDATE Products SET Name='New catalog name',Price=1 WHERE ProductID=1");
    assert.equal(original.items[0].unitPriceCents,6499);
    assert.equal((await db.getAsync("SELECT ProductName FROM OrderItems")).ProductName,"Trail Backpack");
    assert.equal((await db.getAsync("SELECT UnitPriceCents FROM OrderItems")).UnitPriceCents,6499);
    assert.equal((await priceCart([{productId:1,quantity:2}],{database:db})).orderTotal,2);
    assert.deepEqual(await db.allAsync("PRAGMA foreign_key_check"),[]);
});

test("pricing preserves database errors and rejects invalid integration contexts", async t=> {
    const {db}=fixture(t); await db.closeAsync();
    await assert.rejects(priceCart([{productId:1,quantity:1}],{database:db}),{code:"DB_CLOSED"});
    for (const options of [null,[],{database:null},{database:{}},{transaction:null},{transaction:{}},{database:db,transaction:{all(){}}}]) {
        await assert.rejects(priceCart([{productId:1,quantity:1}],options),TypeError);
    }
});

test("default priceCart(items) works only against its explicitly configured synthetic path in this test", t=> {
    const {filename}=fixture(t);
    const target=filename+"-default";
    const code=[
        'const assert=require("node:assert/strict"); const fs=require("node:fs");',
        'const pricing=require(process.argv[1]); const db=require(process.argv[2]);',
        '(async()=> { assert.equal(fs.existsSync(process.env.DB_PATH),false);',
        'await assert.rejects(pricing.priceCart([]),{code:"INVALID_CART"});',
        'assert.equal(fs.existsSync(process.env.DB_PATH),false);',
        'const result=await pricing.priceCart([{productId:1,quantity:1}]);',
        'assert.equal(result.orderTotal,64.99); await db.closeAsync();',
        '})().catch(error=> {console.error(error);process.exitCode=1;});',
    ].join("\n");
    const result=spawnSync(process.execPath,["-e",code,path.resolve(__dirname,"../server/services/pricingService.js"),path.resolve(__dirname,"../server/database/db.js")],{env:{...process.env,DB_PATH:target},encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);
});
