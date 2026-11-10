"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_CENTS, MoneyError, toCents, fromCents, addCents, multiplyCents } = require("../server/services/moneyService");

test("decimal money parses to exact integer cents without floating-point multiplication", () => {
    for (const [dollars, cents] of [[0,0], [0.01,1], [0.29,29], [0.57,57], [1.01,101], [19.99,1999], [64.99,6499], ["0001.20",120], ["12",1200], ["12.3",1230], ["12.30",1230]]) {
        assert.equal(toCents(dollars), cents);
    }
    assert.equal(toCents(-0), 0);
});

test("money rejects malformed, nonfinite, negative and unsupported values without coercion", () => {
    for (const value of [undefined,null,true,false,[],{},1n,new Number(1),NaN,Infinity,-Infinity,-1,""," "," 1","1 ","+1","-1","-0",".50","1.","1e2","0x10","1,000","NaN","Infinity"]) {
        assert.throws(() => toCents(value), MoneyError);
    }
});

test("excess decimal precision and binary arithmetic artifacts are rejected rather than rounded", () => {
    for (const value of ["1.000","0.001",1.005,2.999,0.1+0.2]) {
        assert.throws(() => toCents(value), { code: "MONEY_PRECISION" });
    }
    assert.throws(() => toCents(1e-7), MoneyError);
});

test("money conversion checks safe integer-cent boundaries before returning Numbers", () => {
    assert.equal(toCents("90071992547409.91"), MAX_CENTS);
    assert.equal(toCents("90071992547409.90"), MAX_CENTS-1);
    for (const value of ["90071992547409.92","1000000000000000",Number.MAX_VALUE]) {
        assert.throws(() => toCents(value), { code: "MONEY_OVERFLOW" });
    }
});

test("cent addition is exact and rejects overflow", () => {
    assert.equal(addCents(toCents(0.1),toCents(0.2)),30);
    assert.equal(fromCents(addCents(toCents(0.1),toCents(0.2))),0.3);
    assert.equal(addCents(MAX_CENTS,0),MAX_CENTS);
    assert.throws(() => addCents(MAX_CENTS,1), { code: "MONEY_OVERFLOW" });
});

test("cent multiplication is exact and rejects overflow", () => {
    assert.equal(multiplyCents(1999,3),5997);
    assert.equal(multiplyCents(0,999),0);
    assert.equal(multiplyCents(123,0),0);
    assert.equal(multiplyCents(MAX_CENTS,1),MAX_CENTS);
    assert.throws(() => multiplyCents(MAX_CENTS,2), { code: "MONEY_OVERFLOW" });
});

test("all cent operations validate integer inputs and multiplication validates its quantity", () => {
    for (const value of [-1,0.5,NaN,Infinity,"1",null,undefined]) {
        assert.throws(() => fromCents(value),MoneyError);
        assert.throws(() => addCents(value,0),MoneyError);
        assert.throws(() => addCents(0,value),MoneyError);
        assert.throws(() => multiplyCents(value,1),MoneyError);
    }
    for (const value of [-1,0.5,NaN,Infinity,"1",null,undefined]) assert.throws(() => multiplyCents(1,value),MoneyError);
    assert.throws(() => fromCents(MAX_CENTS+1), { code: "MONEY_OVERFLOW" });
    assert.throws(() => multiplyCents(1,MAX_CENTS+1), { code: "MONEY_OVERFLOW" });
});

test("numeric dollar conversion round-trips ordinary cents and rejects precision loss at extreme values", () => {
    for (let cents=0;cents<=10000;cents+=17) assert.equal(toCents(fromCents(cents)),cents);
    assert.equal(fromCents(MAX_CENTS-1),90071992547409.9);
    assert.throws(() => fromCents(MAX_CENTS), { code: "MONEY_OVERFLOW" });
});
