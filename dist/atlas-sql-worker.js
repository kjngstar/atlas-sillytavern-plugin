"use strict";
(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // ../../node_modules/sql.js/dist/sql-wasm-browser.js
  var require_sql_wasm_browser = __commonJS({
    "../../node_modules/sql.js/dist/sql-wasm-browser.js"(exports, module) {
      var initSqlJsPromise = void 0;
      var initSqlJs2 = function(moduleConfig) {
        if (initSqlJsPromise) {
          return initSqlJsPromise;
        }
        initSqlJsPromise = new Promise(function(resolveModule, reject) {
          var Module = typeof moduleConfig !== "undefined" ? moduleConfig : {};
          var originalOnAbortFunction = Module["onAbort"];
          Module["onAbort"] = function(errorThatCausedAbort) {
            reject(new Error(errorThatCausedAbort));
            if (originalOnAbortFunction) {
              originalOnAbortFunction(errorThatCausedAbort);
            }
          };
          Module["postRun"] = Module["postRun"] || [];
          Module["postRun"].push(function() {
            resolveModule(Module);
          });
          module = void 0;
          var k;
          k ||= typeof Module != "undefined" ? Module : {};
          var aa = !!globalThis.window, ba = !!globalThis.WorkerGlobalScope;
          k.onRuntimeInitialized = function() {
            function a(f, l) {
              switch (typeof l) {
                case "boolean":
                  $b(f, l ? 1 : 0);
                  break;
                case "number":
                  ac(f, l);
                  break;
                case "string":
                  bc(f, l, -1, -1);
                  break;
                case "object":
                  if (null === l) eb(f);
                  else if (null != l.length) {
                    var n = ca(l.length);
                    m.set(l, n);
                    cc(f, n, l.length, -1);
                    da(n);
                  } else ra(f, "Wrong API use : tried to return a value of an unknown type (" + l + ").", -1);
                  break;
                default:
                  eb(f);
              }
            }
            function b(f, l) {
              for (var n = [], p = 0; p < f; p += 1) {
                var u = r(l + 4 * p, "i32"), v = dc(u);
                if (1 === v || 2 === v) u = ec(u);
                else if (3 === v) u = fc(u);
                else if (4 === v) {
                  v = u;
                  u = gc(v);
                  v = hc(v);
                  for (var K = new Uint8Array(u), I = 0; I < u; I += 1) K[I] = m[v + I];
                  u = K;
                } else u = null;
                n.push(u);
              }
              return n;
            }
            function c(f, l) {
              this.Qa = f;
              this.db = l;
              this.Oa = 1;
              this.yb = [];
            }
            function d(f, l) {
              this.db = l;
              this.ob = ea(f);
              if (null === this.ob) throw Error("Unable to allocate memory for the SQL string");
              this.ub = this.ob;
              this.gb = this.Fb = null;
            }
            function e(f) {
              this.filename = "dbfile_" + (4294967295 * Math.random() >>> 0);
              if (null != f) {
                var l = this.filename, n = "/", p = l;
                n && (n = "string" == typeof n ? n : fa(n), p = l ? ha(n + "/" + l) : n);
                l = ia(true, true);
                p = ja(
                  p,
                  l
                );
                if (f) {
                  if ("string" == typeof f) {
                    n = Array(f.length);
                    for (var u = 0, v = f.length; u < v; ++u) n[u] = f.charCodeAt(u);
                    f = n;
                  }
                  ka(p, l | 146);
                  n = la(p, 577);
                  ma(n, f, 0, f.length, 0);
                  na(n);
                  ka(p, l);
                }
              }
              this.handleError(q(this.filename, g));
              this.db = r(g, "i32");
              hb(this.db);
              this.pb = {};
              this.Sa = {};
            }
            var g = y(4), h = k.cwrap, q = h("sqlite3_open", "number", ["string", "number"]), w = h("sqlite3_close_v2", "number", ["number"]), t = h("sqlite3_exec", "number", ["number", "string", "number", "number", "number"]), x = h("sqlite3_changes", "number", ["number"]), D = h(
              "sqlite3_prepare_v2",
              "number",
              ["number", "string", "number", "number", "number"]
            ), ib = h("sqlite3_sql", "string", ["number"]), jc = h("sqlite3_normalized_sql", "string", ["number"]), jb = h("sqlite3_prepare_v2", "number", ["number", "number", "number", "number", "number"]), kc = h("sqlite3_bind_text", "number", ["number", "number", "number", "number", "number"]), kb = h("sqlite3_bind_blob", "number", ["number", "number", "number", "number", "number"]), lc = h("sqlite3_bind_double", "number", ["number", "number", "number"]), mc = h("sqlite3_bind_int", "number", [
              "number",
              "number",
              "number"
            ]), nc = h("sqlite3_bind_parameter_index", "number", ["number", "string"]), oc = h("sqlite3_step", "number", ["number"]), pc = h("sqlite3_errmsg", "string", ["number"]), qc = h("sqlite3_column_count", "number", ["number"]), rc = h("sqlite3_data_count", "number", ["number"]), sc = h("sqlite3_column_double", "number", ["number", "number"]), lb = h("sqlite3_column_text", "string", ["number", "number"]), tc = h("sqlite3_column_blob", "number", ["number", "number"]), uc = h("sqlite3_column_bytes", "number", ["number", "number"]), vc = h(
              "sqlite3_column_type",
              "number",
              ["number", "number"]
            ), wc = h("sqlite3_column_name", "string", ["number", "number"]), xc = h("sqlite3_reset", "number", ["number"]), yc = h("sqlite3_clear_bindings", "number", ["number"]), zc = h("sqlite3_finalize", "number", ["number"]), mb = h("sqlite3_create_function_v2", "number", "number string number number number number number number number".split(" ")), dc = h("sqlite3_value_type", "number", ["number"]), gc = h("sqlite3_value_bytes", "number", ["number"]), fc = h("sqlite3_value_text", "string", ["number"]), hc = h(
              "sqlite3_value_blob",
              "number",
              ["number"]
            ), ec = h("sqlite3_value_double", "number", ["number"]), ac = h("sqlite3_result_double", "", ["number", "number"]), eb = h("sqlite3_result_null", "", ["number"]), bc = h("sqlite3_result_text", "", ["number", "string", "number", "number"]), cc = h("sqlite3_result_blob", "", ["number", "number", "number", "number"]), $b = h("sqlite3_result_int", "", ["number", "number"]), ra = h("sqlite3_result_error", "", ["number", "string", "number"]), nb = h("sqlite3_aggregate_context", "number", ["number", "number"]), hb = h(
              "RegisterExtensionFunctions",
              "number",
              ["number"]
            ), ob = h("sqlite3_update_hook", "number", ["number", "number", "number"]);
            c.prototype.bind = function(f) {
              if (!this.Qa) throw "Statement closed";
              this.reset();
              return Array.isArray(f) ? this.Wb(f) : null != f && "object" === typeof f ? this.Xb(f) : true;
            };
            c.prototype.step = function() {
              if (!this.Qa) throw "Statement closed";
              this.Oa = 1;
              var f = oc(this.Qa);
              switch (f) {
                case 100:
                  return true;
                case 101:
                  return false;
                default:
                  throw this.db.handleError(f);
              }
            };
            c.prototype.Pb = function(f) {
              null == f && (f = this.Oa, this.Oa += 1);
              return sc(this.Qa, f);
            };
            c.prototype.hc = function(f) {
              null == f && (f = this.Oa, this.Oa += 1);
              f = lb(this.Qa, f);
              if ("function" !== typeof BigInt) throw Error("BigInt is not supported");
              return BigInt(f);
            };
            c.prototype.mc = function(f) {
              null == f && (f = this.Oa, this.Oa += 1);
              return lb(this.Qa, f);
            };
            c.prototype.getBlob = function(f) {
              null == f && (f = this.Oa, this.Oa += 1);
              var l = uc(this.Qa, f);
              f = tc(this.Qa, f);
              for (var n = new Uint8Array(l), p = 0; p < l; p += 1) n[p] = m[f + p];
              return n;
            };
            c.prototype.get = function(f, l) {
              l = l || {};
              null != f && this.bind(f) && this.step();
              f = [];
              for (var n = rc(this.Qa), p = 0; p < n; p += 1) switch (vc(this.Qa, p)) {
                case 1:
                  var u = l.useBigInt ? this.hc(p) : this.Pb(p);
                  f.push(u);
                  break;
                case 2:
                  f.push(this.Pb(p));
                  break;
                case 3:
                  f.push(this.mc(p));
                  break;
                case 4:
                  f.push(this.getBlob(p));
                  break;
                default:
                  f.push(null);
              }
              return f;
            };
            c.prototype.Db = function() {
              for (var f = [], l = qc(this.Qa), n = 0; n < l; n += 1) f.push(wc(this.Qa, n));
              return f;
            };
            c.prototype.Ob = function(f, l) {
              f = this.get(f, l);
              l = this.Db();
              for (var n = {}, p = 0; p < l.length; p += 1) n[l[p]] = f[p];
              return n;
            };
            c.prototype.lc = function() {
              return ib(this.Qa);
            };
            c.prototype.ic = function() {
              return jc(this.Qa);
            };
            c.prototype.Jb = function(f) {
              null != f && this.bind(f);
              this.step();
              return this.reset();
            };
            c.prototype.Lb = function(f, l) {
              null == l && (l = this.Oa, this.Oa += 1);
              f = ea(f);
              this.yb.push(f);
              this.db.handleError(kc(this.Qa, l, f, -1, 0));
            };
            c.prototype.Vb = function(f, l) {
              null == l && (l = this.Oa, this.Oa += 1);
              var n = ca(f.length);
              m.set(f, n);
              this.yb.push(n);
              this.db.handleError(kb(this.Qa, l, n, f.length, 0));
            };
            c.prototype.Kb = function(f, l) {
              null == l && (l = this.Oa, this.Oa += 1);
              this.db.handleError((f === (f | 0) ? mc : lc)(
                this.Qa,
                l,
                f
              ));
            };
            c.prototype.Yb = function(f) {
              null == f && (f = this.Oa, this.Oa += 1);
              kb(this.Qa, f, 0, 0, 0);
            };
            c.prototype.Mb = function(f, l) {
              null == l && (l = this.Oa, this.Oa += 1);
              switch (typeof f) {
                case "string":
                  this.Lb(f, l);
                  return;
                case "number":
                  this.Kb(f, l);
                  return;
                case "bigint":
                  this.Lb(f.toString(), l);
                  return;
                case "boolean":
                  this.Kb(f + 0, l);
                  return;
                case "object":
                  if (null === f) {
                    this.Yb(l);
                    return;
                  }
                  if (null != f.length) {
                    this.Vb(f, l);
                    return;
                  }
              }
              throw "Wrong API use : tried to bind a value of an unknown type (" + f + ").";
            };
            c.prototype.Xb = function(f) {
              var l = this;
              Object.keys(f).forEach(function(n) {
                var p = nc(l.Qa, n);
                0 !== p && l.Mb(f[n], p);
              });
              return true;
            };
            c.prototype.Wb = function(f) {
              for (var l = 0; l < f.length; l += 1) this.Mb(f[l], l + 1);
              return true;
            };
            c.prototype.reset = function() {
              this.Cb();
              return 0 === yc(this.Qa) && 0 === xc(this.Qa);
            };
            c.prototype.Cb = function() {
              for (var f; void 0 !== (f = this.yb.pop()); ) da(f);
            };
            c.prototype.cb = function() {
              this.Cb();
              var f = 0 === zc(this.Qa);
              delete this.db.pb[this.Qa];
              this.Qa = 0;
              return f;
            };
            d.prototype.next = function() {
              if (null === this.ob) return { done: true };
              null !== this.gb && (this.gb.cb(), this.gb = null);
              if (!this.db.db) throw this.Ab(), Error("Database closed");
              var f = oa(), l = y(4);
              pa(g);
              pa(l);
              try {
                this.db.handleError(jb(this.db.db, this.ub, -1, g, l));
                this.ub = r(l, "i32");
                var n = r(g, "i32");
                if (0 === n) return this.Ab(), { done: true };
                this.gb = new c(n, this.db);
                this.db.pb[n] = this.gb;
                return { value: this.gb, done: false };
              } catch (p) {
                throw this.Fb = z(this.ub), this.Ab(), p;
              } finally {
                qa(f);
              }
            };
            d.prototype.Ab = function() {
              da(this.ob);
              this.ob = null;
            };
            d.prototype.jc = function() {
              return null !== this.Fb ? this.Fb : z(this.ub);
            };
            "function" === typeof Symbol && "symbol" === typeof Symbol.iterator && (d.prototype[Symbol.iterator] = function() {
              return this;
            });
            e.prototype.Jb = function(f, l) {
              if (!this.db) throw "Database closed";
              if (l) {
                f = this.Gb(f, l);
                try {
                  f.step();
                } finally {
                  f.cb();
                }
              } else this.handleError(t(this.db, f, 0, 0, g));
              return this;
            };
            e.prototype.exec = function(f, l, n) {
              if (!this.db) throw "Database closed";
              var p = null, u = null, v = null;
              try {
                v = u = ea(f);
                var K = y(4);
                for (f = []; 0 !== r(v, "i8"); ) {
                  pa(g);
                  pa(K);
                  this.handleError(jb(this.db, v, -1, g, K));
                  var I = r(g, "i32");
                  v = r(
                    K,
                    "i32"
                  );
                  if (0 !== I) {
                    var H = null;
                    p = new c(I, this);
                    for (null != l && p.bind(l); p.step(); ) null === H && (H = { columns: p.Db(), values: [] }, f.push(H)), H.values.push(p.get(null, n));
                    p.cb();
                  }
                }
                return f;
              } catch (L) {
                throw p && p.cb(), L;
              } finally {
                u && da(u);
              }
            };
            e.prototype.ec = function(f, l, n, p, u) {
              "function" === typeof l && (p = n, n = l, l = void 0);
              f = this.Gb(f, l);
              try {
                for (; f.step(); ) n(f.Ob(null, u));
              } finally {
                f.cb();
              }
              if ("function" === typeof p) return p();
            };
            e.prototype.Gb = function(f, l) {
              pa(g);
              this.handleError(D(this.db, f, -1, g, 0));
              f = r(g, "i32");
              if (0 === f) throw "Nothing to prepare";
              var n = new c(f, this);
              null != l && n.bind(l);
              return this.pb[f] = n;
            };
            e.prototype.pc = function(f) {
              return new d(f, this);
            };
            e.prototype.fc = function() {
              Object.values(this.pb).forEach(function(l) {
                l.cb();
              });
              Object.values(this.Sa).forEach(A);
              this.Sa = {};
              this.handleError(w(this.db));
              var f = sa(this.filename);
              this.handleError(q(this.filename, g));
              this.db = r(g, "i32");
              hb(this.db);
              return f;
            };
            e.prototype.close = function() {
              null !== this.db && (Object.values(this.pb).forEach(function(f) {
                f.cb();
              }), Object.values(this.Sa).forEach(A), this.Sa = {}, this.fb && (A(this.fb), this.fb = void 0), this.handleError(w(this.db)), ta("/" + this.filename), this.db = null);
            };
            e.prototype.handleError = function(f) {
              if (0 === f) return null;
              f = pc(this.db);
              throw Error(f);
            };
            e.prototype.kc = function() {
              return x(this.db);
            };
            e.prototype.bc = function(f, l) {
              Object.prototype.hasOwnProperty.call(this.Sa, f) && (A(this.Sa[f]), delete this.Sa[f]);
              var n = ua(function(p, u, v) {
                u = b(u, v);
                try {
                  var K = l.apply(null, u);
                } catch (I) {
                  ra(p, I, -1);
                  return;
                }
                a(p, K);
              }, "viii");
              this.Sa[f] = n;
              this.handleError(mb(
                this.db,
                f,
                l.length,
                1,
                0,
                n,
                0,
                0,
                0
              ));
              return this;
            };
            e.prototype.ac = function(f, l) {
              var n = l.init || function() {
                return null;
              }, p = l.finalize || function(H) {
                return H;
              }, u = l.step;
              if (!u) throw "An aggregate function must have a step function in " + f;
              var v = {};
              Object.hasOwnProperty.call(this.Sa, f) && (A(this.Sa[f]), delete this.Sa[f]);
              l = f + "__finalize";
              Object.hasOwnProperty.call(this.Sa, l) && (A(this.Sa[l]), delete this.Sa[l]);
              var K = ua(function(H, L, Ka) {
                var V = nb(H, 1);
                Object.hasOwnProperty.call(v, V) || (v[V] = n());
                L = b(L, Ka);
                L = [v[V]].concat(L);
                try {
                  v[V] = u.apply(
                    null,
                    L
                  );
                } catch (Bc) {
                  delete v[V], ra(H, Bc, -1);
                }
              }, "viii"), I = ua(function(H) {
                var L = nb(H, 1);
                try {
                  var Ka = p(v[L]);
                } catch (V) {
                  delete v[L];
                  ra(H, V, -1);
                  return;
                }
                a(H, Ka);
                delete v[L];
              }, "vi");
              this.Sa[f] = K;
              this.Sa[l] = I;
              this.handleError(mb(this.db, f, u.length - 1, 1, 0, 0, K, I, 0));
              return this;
            };
            e.prototype.vc = function(f) {
              this.fb && (ob(this.db, 0, 0), A(this.fb), this.fb = void 0);
              if (!f) return this;
              this.fb = ua(function(l, n, p, u, v) {
                switch (n) {
                  case 18:
                    l = "insert";
                    break;
                  case 23:
                    l = "update";
                    break;
                  case 9:
                    l = "delete";
                    break;
                  default:
                    throw "unknown operationCode in updateHook callback: " + n;
                }
                p = z(p);
                u = z(u);
                if (v > Number.MAX_SAFE_INTEGER) throw "rowId too big to fit inside a Number";
                f(l, p, u, Number(v));
              }, "viiiij");
              ob(this.db, this.fb, 0);
              return this;
            };
            c.prototype.bind = c.prototype.bind;
            c.prototype.step = c.prototype.step;
            c.prototype.get = c.prototype.get;
            c.prototype.getColumnNames = c.prototype.Db;
            c.prototype.getAsObject = c.prototype.Ob;
            c.prototype.getSQL = c.prototype.lc;
            c.prototype.getNormalizedSQL = c.prototype.ic;
            c.prototype.run = c.prototype.Jb;
            c.prototype.reset = c.prototype.reset;
            c.prototype.freemem = c.prototype.Cb;
            c.prototype.free = c.prototype.cb;
            d.prototype.next = d.prototype.next;
            d.prototype.getRemainingSQL = d.prototype.jc;
            e.prototype.run = e.prototype.Jb;
            e.prototype.exec = e.prototype.exec;
            e.prototype.each = e.prototype.ec;
            e.prototype.prepare = e.prototype.Gb;
            e.prototype.iterateStatements = e.prototype.pc;
            e.prototype["export"] = e.prototype.fc;
            e.prototype.close = e.prototype.close;
            e.prototype.handleError = e.prototype.handleError;
            e.prototype.getRowsModified = e.prototype.kc;
            e.prototype.create_function = e.prototype.bc;
            e.prototype.create_aggregate = e.prototype.ac;
            e.prototype.updateHook = e.prototype.vc;
            k.Database = e;
          };
          var va = "./this.program", wa = globalThis.document?.currentScript?.src;
          ba && (wa = self.location.href);
          var xa = "", ya, za;
          if (aa || ba) {
            try {
              xa = new URL(".", wa).href;
            } catch {
            }
            ba && (za = (a) => {
              var b = new XMLHttpRequest();
              b.open("GET", a, false);
              b.responseType = "arraybuffer";
              b.send(null);
              return new Uint8Array(b.response);
            });
            ya = async (a) => {
              a = await fetch(a, { credentials: "same-origin" });
              if (a.ok) return a.arrayBuffer();
              throw Error(a.status + " : " + a.url);
            };
          }
          var Aa = console.log.bind(console), B = console.error.bind(console), Ba, Ca = false, Da, m, C, Ea, E, F, Fa, Ga, G;
          function Ha() {
            var a = Ia.buffer;
            m = new Int8Array(a);
            Ea = new Int16Array(a);
            C = new Uint8Array(a);
            new Uint16Array(a);
            E = new Int32Array(a);
            F = new Uint32Array(a);
            Fa = new Float32Array(a);
            Ga = new Float64Array(a);
            G = new BigInt64Array(a);
            new BigUint64Array(a);
          }
          function Ja(a) {
            k.onAbort?.(a);
            a = "Aborted(" + a + ")";
            B(a);
            Ca = true;
            throw new WebAssembly.RuntimeError(a + ". Build with -sASSERTIONS for more info.");
          }
          var La;
          async function Ma(a) {
            if (!Ba) try {
              var b = await ya(a);
              return new Uint8Array(b);
            } catch {
            }
            if (a == La && Ba) a = new Uint8Array(Ba);
            else if (za) a = za(a);
            else throw "both async and sync fetching of the wasm failed";
            return a;
          }
          async function Na(a, b) {
            try {
              var c = await Ma(a);
              return await WebAssembly.instantiate(c, b);
            } catch (d) {
              B(`failed to asynchronously prepare wasm: ${d}`), Ja(d);
            }
          }
          async function Oa(a) {
            var b = La;
            if (!Ba) try {
              var c = fetch(b, { credentials: "same-origin" });
              return await WebAssembly.instantiateStreaming(c, a);
            } catch (d) {
              B(`wasm streaming compile failed: ${d}`), B("falling back to ArrayBuffer instantiation");
            }
            return Na(b, a);
          }
          class Pa {
            name = "ExitStatus";
            constructor(a) {
              this.message = `Program terminated with exit(${a})`;
              this.status = a;
            }
          }
          var Qa = (a) => {
            for (; 0 < a.length; ) a.shift()(k);
          }, Ra = [], Sa = [], Ta = () => {
            var a = k.preRun.shift();
            Sa.push(a);
          }, J = 0, Ua = null;
          function r(a, b = "i8") {
            b.endsWith("*") && (b = "*");
            switch (b) {
              case "i1":
                return m[a];
              case "i8":
                return m[a];
              case "i16":
                return Ea[a >> 1];
              case "i32":
                return E[a >> 2];
              case "i64":
                return G[a >> 3];
              case "float":
                return Fa[a >> 2];
              case "double":
                return Ga[a >> 3];
              case "*":
                return F[a >> 2];
              default:
                Ja(`invalid type for getValue: ${b}`);
            }
          }
          var Va = true;
          function pa(a) {
            var b = "i32";
            b.endsWith("*") && (b = "*");
            switch (b) {
              case "i1":
                m[a] = 0;
                break;
              case "i8":
                m[a] = 0;
                break;
              case "i16":
                Ea[a >> 1] = 0;
                break;
              case "i32":
                E[a >> 2] = 0;
                break;
              case "i64":
                G[a >> 3] = BigInt(0);
                break;
              case "float":
                Fa[a >> 2] = 0;
                break;
              case "double":
                Ga[a >> 3] = 0;
                break;
              case "*":
                F[a >> 2] = 0;
                break;
              default:
                Ja(`invalid type for setValue: ${b}`);
            }
          }
          var Wa = new TextDecoder(), Xa = (a, b, c, d) => {
            c = b + c;
            if (d) return c;
            for (; a[b] && !(b >= c); ) ++b;
            return b;
          }, z = (a, b, c) => a ? Wa.decode(C.subarray(a, Xa(C, a, b, c))) : "", Ya = (a, b) => {
            for (var c = 0, d = a.length - 1; 0 <= d; d--) {
              var e = a[d];
              "." === e ? a.splice(d, 1) : ".." === e ? (a.splice(d, 1), c++) : c && (a.splice(d, 1), c--);
            }
            if (b) for (; c; c--) a.unshift("..");
            return a;
          }, ha = (a) => {
            var b = "/" === a.charAt(0), c = "/" === a.slice(-1);
            (a = Ya(a.split("/").filter((d) => !!d), !b).join("/")) || b || (a = ".");
            a && c && (a += "/");
            return (b ? "/" : "") + a;
          }, Za = (a) => {
            var b = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/.exec(a).slice(1);
            a = b[0];
            b = b[1];
            if (!a && !b) return ".";
            b &&= b.slice(0, -1);
            return a + b;
          }, $a = (a) => a && a.match(/([^\/]+|\/)\/*$/)[1], ab = () => (a) => crypto.getRandomValues(a), bb = (a) => {
            (bb = ab())(a);
          }, cb = (...a) => {
            for (var b = "", c = false, d = a.length - 1; -1 <= d && !c; d--) {
              c = 0 <= d ? a[d] : "/";
              if ("string" != typeof c) throw new TypeError("Arguments to path.resolve must be strings");
              if (!c) return "";
              b = c + "/" + b;
              c = "/" === c.charAt(0);
            }
            b = Ya(b.split("/").filter((e) => !!e), !c).join("/");
            return (c ? "/" : "") + b || ".";
          }, db = (a) => {
            var b = Xa(a, 0);
            return Wa.decode(a.buffer ? a.subarray(0, b) : new Uint8Array(a.slice(0, b)));
          }, fb = [], gb = (a) => {
            for (var b = 0, c = 0; c < a.length; ++c) {
              var d = a.charCodeAt(c);
              127 >= d ? b++ : 2047 >= d ? b += 2 : 55296 <= d && 57343 >= d ? (b += 4, ++c) : b += 3;
            }
            return b;
          }, M = (a, b, c, d) => {
            if (!(0 < d)) return 0;
            var e = c;
            d = c + d - 1;
            for (var g = 0; g < a.length; ++g) {
              var h = a.codePointAt(g);
              if (127 >= h) {
                if (c >= d) break;
                b[c++] = h;
              } else if (2047 >= h) {
                if (c + 1 >= d) break;
                b[c++] = 192 | h >> 6;
                b[c++] = 128 | h & 63;
              } else if (65535 >= h) {
                if (c + 2 >= d) break;
                b[c++] = 224 | h >> 12;
                b[c++] = 128 | h >> 6 & 63;
                b[c++] = 128 | h & 63;
              } else {
                if (c + 3 >= d) break;
                b[c++] = 240 | h >> 18;
                b[c++] = 128 | h >> 12 & 63;
                b[c++] = 128 | h >> 6 & 63;
                b[c++] = 128 | h & 63;
                g++;
              }
            }
            b[c] = 0;
            return c - e;
          }, pb = [];
          function qb(a, b) {
            pb[a] = { input: [], output: [], kb: b };
            rb(a, sb);
          }
          var sb = { open(a) {
            var b = pb[a.node.nb];
            if (!b) throw new N(43);
            a.Va = b;
            a.seekable = false;
          }, close(a) {
            a.Va.kb.lb(a.Va);
          }, lb(a) {
            a.Va.kb.lb(a.Va);
          }, read(a, b, c, d) {
            if (!a.Va || !a.Va.kb.Qb) throw new N(60);
            for (var e = 0, g = 0; g < d; g++) {
              try {
                var h = a.Va.kb.Qb(a.Va);
              } catch (q) {
                throw new N(29);
              }
              if (void 0 === h && 0 === e) throw new N(6);
              if (null === h || void 0 === h) break;
              e++;
              b[c + g] = h;
            }
            e && (a.node.$a = Date.now());
            return e;
          }, write(a, b, c, d) {
            if (!a.Va || !a.Va.kb.Hb) throw new N(60);
            try {
              for (var e = 0; e < d; e++) a.Va.kb.Hb(a.Va, b[c + e]);
            } catch (g) {
              throw new N(29);
            }
            d && (a.node.Ua = a.node.Ta = Date.now());
            return e;
          } }, tb = { Qb() {
            a: {
              if (!fb.length) {
                var a = null;
                globalThis.window?.prompt && (a = window.prompt("Input: "), null !== a && (a += "\n"));
                if (!a) {
                  var b = null;
                  break a;
                }
                b = Array(gb(a) + 1);
                a = M(a, b, 0, b.length);
                b.length = a;
                fb = b;
              }
              b = fb.shift();
            }
            return b;
          }, Hb(a, b) {
            null === b || 10 === b ? (Aa(db(a.output)), a.output = []) : 0 != b && a.output.push(b);
          }, lb(a) {
            0 < a.output?.length && (Aa(db(a.output)), a.output = []);
          }, Dc() {
            return { yc: 25856, Ac: 5, xc: 191, zc: 35387, wc: [
              3,
              28,
              127,
              21,
              4,
              0,
              1,
              0,
              17,
              19,
              26,
              0,
              18,
              15,
              23,
              22,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0
            ] };
          }, Ec() {
            return 0;
          }, Fc() {
            return [24, 80];
          } }, ub = { Hb(a, b) {
            null === b || 10 === b ? (B(db(a.output)), a.output = []) : 0 != b && a.output.push(b);
          }, lb(a) {
            0 < a.output?.length && (B(db(a.output)), a.output = []);
          } }, O = { Za: null, ab() {
            return O.createNode(null, "/", 16895, 0);
          }, createNode(a, b, c, d) {
            if (24576 === (c & 61440) || 4096 === (c & 61440)) throw new N(63);
            O.Za || (O.Za = { dir: { node: { Wa: O.La.Wa, Xa: O.La.Xa, mb: O.La.mb, rb: O.La.rb, Tb: O.La.Tb, xb: O.La.xb, vb: O.La.vb, Ib: O.La.Ib, wb: O.La.wb }, stream: { Ya: O.Ma.Ya } }, file: {
              node: { Wa: O.La.Wa, Xa: O.La.Xa },
              stream: { Ya: O.Ma.Ya, read: O.Ma.read, write: O.Ma.write, sb: O.Ma.sb, tb: O.Ma.tb }
            }, link: { node: { Wa: O.La.Wa, Xa: O.La.Xa, eb: O.La.eb }, stream: {} }, Nb: { node: { Wa: O.La.Wa, Xa: O.La.Xa }, stream: vb } });
            c = wb(a, b, c, d);
            P(c.mode) ? (c.La = O.Za.dir.node, c.Ma = O.Za.dir.stream, c.Na = {}) : 32768 === (c.mode & 61440) ? (c.La = O.Za.file.node, c.Ma = O.Za.file.stream, c.Ra = 0, c.Na = null) : 40960 === (c.mode & 61440) ? (c.La = O.Za.link.node, c.Ma = O.Za.link.stream) : 8192 === (c.mode & 61440) && (c.La = O.Za.Nb.node, c.Ma = O.Za.Nb.stream);
            c.$a = c.Ua = c.Ta = Date.now();
            a && (a.Na[b] = c, a.$a = a.Ua = a.Ta = c.$a);
            return c;
          }, Cc(a) {
            return a.Na ? a.Na.subarray ? a.Na.subarray(0, a.Ra) : new Uint8Array(a.Na) : new Uint8Array(0);
          }, La: { Wa(a) {
            var b = {};
            b.cc = 8192 === (a.mode & 61440) ? a.id : 1;
            b.oc = a.id;
            b.mode = a.mode;
            b.rc = 1;
            b.uid = 0;
            b.nc = 0;
            b.nb = a.nb;
            P(a.mode) ? b.size = 4096 : 32768 === (a.mode & 61440) ? b.size = a.Ra : 40960 === (a.mode & 61440) ? b.size = a.link.length : b.size = 0;
            b.$a = new Date(a.$a);
            b.Ua = new Date(a.Ua);
            b.Ta = new Date(a.Ta);
            b.Zb = 4096;
            b.$b = Math.ceil(b.size / b.Zb);
            return b;
          }, Xa(a, b) {
            for (var c of ["mode", "atime", "mtime", "ctime"]) null != b[c] && (a[c] = b[c]);
            void 0 !== b.size && (b = b.size, a.Ra != b && (0 == b ? (a.Na = null, a.Ra = 0) : (c = a.Na, a.Na = new Uint8Array(b), c && a.Na.set(c.subarray(0, Math.min(b, a.Ra))), a.Ra = b)));
          }, mb() {
            O.zb || (O.zb = new N(44), O.zb.stack = "<generic error, no stack>");
            throw O.zb;
          }, rb(a, b, c, d) {
            return O.createNode(a, b, c, d);
          }, Tb(a, b, c) {
            try {
              var d = Q(b, c);
            } catch (g) {
            }
            if (d) {
              if (P(a.mode)) for (var e in d.Na) throw new N(55);
              xb(d);
            }
            delete a.parent.Na[a.name];
            b.Na[c] = a;
            a.name = c;
            b.Ta = b.Ua = a.parent.Ta = a.parent.Ua = Date.now();
          }, xb(a, b) {
            delete a.Na[b];
            a.Ta = a.Ua = Date.now();
          }, vb(a, b) {
            var c = Q(a, b), d;
            for (d in c.Na) throw new N(55);
            delete a.Na[b];
            a.Ta = a.Ua = Date.now();
          }, Ib(a) {
            return [".", "..", ...Object.keys(a.Na)];
          }, wb(a, b, c) {
            a = O.createNode(a, b, 41471, 0);
            a.link = c;
            return a;
          }, eb(a) {
            if (40960 !== (a.mode & 61440)) throw new N(28);
            return a.link;
          } }, Ma: { read(a, b, c, d, e) {
            var g = a.node.Na;
            if (e >= a.node.Ra) return 0;
            a = Math.min(a.node.Ra - e, d);
            if (8 < a && g.subarray) b.set(g.subarray(e, e + a), c);
            else for (d = 0; d < a; d++) b[c + d] = g[e + d];
            return a;
          }, write(a, b, c, d, e, g) {
            b.buffer === m.buffer && (g = false);
            if (!d) return 0;
            a = a.node;
            a.Ua = a.Ta = Date.now();
            if (b.subarray && (!a.Na || a.Na.subarray)) {
              if (g) return a.Na = b.subarray(c, c + d), a.Ra = d;
              if (0 === a.Ra && 0 === e) return a.Na = b.slice(c, c + d), a.Ra = d;
              if (e + d <= a.Ra) return a.Na.set(b.subarray(c, c + d), e), d;
            }
            g = e + d;
            var h = a.Na ? a.Na.length : 0;
            h >= g || (g = Math.max(g, h * (1048576 > h ? 2 : 1.125) >>> 0), 0 != h && (g = Math.max(g, 256)), h = a.Na, a.Na = new Uint8Array(g), 0 < a.Ra && a.Na.set(h.subarray(0, a.Ra), 0));
            if (a.Na.subarray && b.subarray) a.Na.set(b.subarray(c, c + d), e);
            else for (g = 0; g < d; g++) a.Na[e + g] = b[c + g];
            a.Ra = Math.max(
              a.Ra,
              e + d
            );
            return d;
          }, Ya(a, b, c) {
            1 === c ? b += a.position : 2 === c && 32768 === (a.node.mode & 61440) && (b += a.node.Ra);
            if (0 > b) throw new N(28);
            return b;
          }, sb(a, b, c, d, e) {
            if (32768 !== (a.node.mode & 61440)) throw new N(43);
            a = a.node.Na;
            if (e & 2 || !a || a.buffer !== m.buffer) {
              e = true;
              d = 65536 * Math.ceil(b / 65536);
              var g = yb(65536, d);
              g && C.fill(0, g, g + d);
              d = g;
              if (!d) throw new N(48);
              if (a) {
                if (0 < c || c + b < a.length) a.subarray ? a = a.subarray(c, c + b) : a = Array.prototype.slice.call(a, c, c + b);
                m.set(a, d);
              }
            } else e = false, d = a.byteOffset;
            return { tc: d, Ub: e };
          }, tb(a, b, c, d) {
            O.Ma.write(
              a,
              b,
              0,
              d,
              c,
              false
            );
            return 0;
          } } }, ia = (a, b) => {
            var c = 0;
            a && (c |= 365);
            b && (c |= 146);
            return c;
          }, zb = null, Ab = {}, Bb = [], Cb = 1, R = null, Db = false, Eb = true, N = class {
            name = "ErrnoError";
            constructor(a) {
              this.Pa = a;
            }
          }, Fb = class {
            qb = {};
            node = null;
            get flags() {
              return this.qb.flags;
            }
            set flags(a) {
              this.qb.flags = a;
            }
            get position() {
              return this.qb.position;
            }
            set position(a) {
              this.qb.position = a;
            }
          }, Gb = class {
            La = {};
            Ma = {};
            ib = null;
            constructor(a, b, c, d) {
              a ||= this;
              this.parent = a;
              this.ab = a.ab;
              this.id = Cb++;
              this.name = b;
              this.mode = c;
              this.nb = d;
              this.$a = this.Ua = this.Ta = Date.now();
            }
            get read() {
              return 365 === (this.mode & 365);
            }
            set read(a) {
              a ? this.mode |= 365 : this.mode &= -366;
            }
            get write() {
              return 146 === (this.mode & 146);
            }
            set write(a) {
              a ? this.mode |= 146 : this.mode &= -147;
            }
          };
          function S(a, b = {}) {
            if (!a) throw new N(44);
            b.Bb ?? (b.Bb = true);
            "/" === a.charAt(0) || (a = "//" + a);
            var c = 0;
            a: for (; 40 > c; c++) {
              a = a.split("/").filter((q) => !!q);
              for (var d = zb, e = "/", g = 0; g < a.length; g++) {
                var h = g === a.length - 1;
                if (h && b.parent) break;
                if ("." !== a[g]) if (".." === a[g]) if (e = Za(e), d === d.parent) {
                  a = e + "/" + a.slice(g + 1).join("/");
                  c--;
                  continue a;
                } else d = d.parent;
                else {
                  e = ha(e + "/" + a[g]);
                  try {
                    d = Q(d, a[g]);
                  } catch (q) {
                    if (44 === q?.Pa && h && b.sc) return { path: e };
                    throw q;
                  }
                  !d.ib || h && !b.Bb || (d = d.ib.root);
                  if (40960 === (d.mode & 61440) && (!h || b.hb)) {
                    if (!d.La.eb) throw new N(52);
                    d = d.La.eb(d);
                    "/" === d.charAt(0) || (d = Za(e) + "/" + d);
                    a = d + "/" + a.slice(g + 1).join("/");
                    continue a;
                  }
                }
              }
              return { path: e, node: d };
            }
            throw new N(32);
          }
          function fa(a) {
            for (var b; ; ) {
              if (a === a.parent) return a = a.ab.Sb, b ? "/" !== a[a.length - 1] ? `${a}/${b}` : a + b : a;
              b = b ? `${a.name}/${b}` : a.name;
              a = a.parent;
            }
          }
          function Hb(a, b) {
            for (var c = 0, d = 0; d < b.length; d++) c = (c << 5) - c + b.charCodeAt(d) | 0;
            return (a + c >>> 0) % R.length;
          }
          function xb(a) {
            var b = Hb(a.parent.id, a.name);
            if (R[b] === a) R[b] = a.jb;
            else for (b = R[b]; b; ) {
              if (b.jb === a) {
                b.jb = a.jb;
                break;
              }
              b = b.jb;
            }
          }
          function Q(a, b) {
            var c = P(a.mode) ? (c = Ib(a, "x")) ? c : a.La.mb ? 0 : 2 : 54;
            if (c) throw new N(c);
            for (c = R[Hb(a.id, b)]; c; c = c.jb) {
              var d = c.name;
              if (c.parent.id === a.id && d === b) return c;
            }
            return a.La.mb(a, b);
          }
          function wb(a, b, c, d) {
            a = new Gb(a, b, c, d);
            b = Hb(a.parent.id, a.name);
            a.jb = R[b];
            return R[b] = a;
          }
          function P(a) {
            return 16384 === (a & 61440);
          }
          function Ib(a, b) {
            return Eb ? 0 : b.includes("r") && !(a.mode & 292) || b.includes("w") && !(a.mode & 146) || b.includes("x") && !(a.mode & 73) ? 2 : 0;
          }
          function Jb(a, b) {
            if (!P(a.mode)) return 54;
            try {
              return Q(a, b), 20;
            } catch (c) {
            }
            return Ib(a, "wx");
          }
          function Kb(a, b, c) {
            try {
              var d = Q(a, b);
            } catch (e) {
              return e.Pa;
            }
            if (a = Ib(a, "wx")) return a;
            if (c) {
              if (!P(d.mode)) return 54;
              if (d === d.parent || "/" === fa(d)) return 10;
            } else if (P(d.mode)) return 31;
            return 0;
          }
          function Lb(a) {
            if (!a) throw new N(63);
            return a;
          }
          function T(a) {
            a = Bb[a];
            if (!a) throw new N(8);
            return a;
          }
          function Mb(a, b = -1) {
            a = Object.assign(new Fb(), a);
            if (-1 == b) a: {
              for (b = 0; 4096 >= b; b++) if (!Bb[b]) break a;
              throw new N(33);
            }
            a.bb = b;
            return Bb[b] = a;
          }
          function Nb(a, b = -1) {
            a = Mb(a, b);
            a.Ma?.Bc?.(a);
            return a;
          }
          function Ob(a, b, c) {
            var d = a?.Ma.Xa;
            a = d ? a : b;
            d ??= b.La.Xa;
            Lb(d);
            d(a, c);
          }
          var vb = { open(a) {
            a.Ma = Ab[a.node.nb].Ma;
            a.Ma.open?.(a);
          }, Ya() {
            throw new N(70);
          } };
          function rb(a, b) {
            Ab[a] = { Ma: b };
          }
          function Pb(a, b) {
            var c = "/" === b;
            if (c && zb) throw new N(10);
            if (!c && b) {
              var d = S(b, { Bb: false });
              b = d.path;
              d = d.node;
              if (d.ib) throw new N(10);
              if (!P(d.mode)) throw new N(54);
            }
            b = { type: a, Gc: {}, Sb: b, qc: [] };
            a = a.ab(b);
            a.ab = b;
            b.root = a;
            c ? zb = a : d && (d.ib = b, d.ab && d.ab.qc.push(b));
          }
          function Qb(a, b, c) {
            var d = S(a, { parent: true }).node;
            a = $a(a);
            if (!a) throw new N(28);
            if ("." === a || ".." === a) throw new N(20);
            var e = Jb(d, a);
            if (e) throw new N(e);
            if (!d.La.rb) throw new N(63);
            return d.La.rb(d, a, b, c);
          }
          function ja(a, b = 438) {
            return Qb(a, b & 4095 | 32768, 0);
          }
          function U(a, b = 511) {
            return Qb(a, b & 1023 | 16384, 0);
          }
          function Rb(a, b, c) {
            "undefined" == typeof c && (c = b, b = 438);
            Qb(a, b | 8192, c);
          }
          function Sb(a, b) {
            if (!cb(a)) throw new N(44);
            var c = S(b, { parent: true }).node;
            if (!c) throw new N(44);
            b = $a(b);
            var d = Jb(c, b);
            if (d) throw new N(d);
            if (!c.La.wb) throw new N(63);
            c.La.wb(c, b, a);
          }
          function Tb(a) {
            var b = S(a, { parent: true }).node;
            a = $a(a);
            var c = Q(b, a), d = Kb(b, a, true);
            if (d) throw new N(d);
            if (!b.La.vb) throw new N(63);
            if (c.ib) throw new N(10);
            b.La.vb(b, a);
            xb(c);
          }
          function ta(a) {
            var b = S(a, { parent: true }).node;
            if (!b) throw new N(44);
            a = $a(a);
            var c = Q(b, a), d = Kb(b, a, false);
            if (d) throw new N(d);
            if (!b.La.xb) throw new N(63);
            if (c.ib) throw new N(10);
            b.La.xb(b, a);
            xb(c);
          }
          function Ub(a, b) {
            a = S(a, { hb: !b }).node;
            return Lb(a.La.Wa)(a);
          }
          function Vb(a, b, c, d) {
            Ob(a, b, { mode: c & 4095 | b.mode & -4096, Ta: Date.now(), dc: d });
          }
          function ka(a, b) {
            a = "string" == typeof a ? S(a, { hb: true }).node : a;
            Vb(null, a, b);
          }
          function Wb(a, b, c) {
            if (P(b.mode)) throw new N(31);
            if (32768 !== (b.mode & 61440)) throw new N(28);
            var d = Ib(b, "w");
            if (d) throw new N(d);
            Ob(a, b, { size: c, timestamp: Date.now() });
          }
          function la(a, b, c = 438) {
            if ("" === a) throw new N(44);
            if ("string" == typeof b) {
              var d = { r: 0, "r+": 2, w: 577, "w+": 578, a: 1089, "a+": 1090 }[b];
              if ("undefined" == typeof d) throw Error(`Unknown file open mode: ${b}`);
              b = d;
            }
            c = b & 64 ? c & 4095 | 32768 : 0;
            if ("object" == typeof a) d = a;
            else {
              var e = a.endsWith("/");
              var g = S(a, { hb: !(b & 131072), sc: true });
              d = g.node;
              a = g.path;
            }
            g = false;
            if (b & 64) if (d) {
              if (b & 128) throw new N(20);
            } else {
              if (e) throw new N(31);
              d = Qb(a, c | 511, 0);
              g = true;
            }
            if (!d) throw new N(44);
            8192 === (d.mode & 61440) && (b &= -513);
            if (b & 65536 && !P(d.mode)) throw new N(54);
            if (!g && (d ? 40960 === (d.mode & 61440) ? e = 32 : (e = ["r", "w", "rw"][b & 3], b & 512 && (e += "w"), e = P(d.mode) && ("r" !== e || b & 576) ? 31 : Ib(d, e)) : e = 44, e)) throw new N(e);
            b & 512 && !g && (e = d, e = "string" == typeof e ? S(e, { hb: true }).node : e, Wb(null, e, 0));
            b = Mb({ node: d, path: fa(d), flags: b & -131713, seekable: true, position: 0, Ma: d.Ma, uc: [], error: false });
            b.Ma.open && b.Ma.open(b);
            g && ka(d, c & 511);
            return b;
          }
          function na(a) {
            if (null === a.bb) throw new N(8);
            a.Eb && (a.Eb = null);
            try {
              a.Ma.close && a.Ma.close(a);
            } catch (b) {
              throw b;
            } finally {
              Bb[a.bb] = null;
            }
            a.bb = null;
          }
          function Xb(a, b, c) {
            if (null === a.bb) throw new N(8);
            if (!a.seekable || !a.Ma.Ya) throw new N(70);
            if (0 != c && 1 != c && 2 != c) throw new N(28);
            a.position = a.Ma.Ya(a, b, c);
            a.uc = [];
          }
          function Yb(a, b, c, d, e) {
            if (0 > d || 0 > e) throw new N(28);
            if (null === a.bb) throw new N(8);
            if (1 === (a.flags & 2097155)) throw new N(8);
            if (P(a.node.mode)) throw new N(31);
            if (!a.Ma.read) throw new N(28);
            var g = "undefined" != typeof e;
            if (!g) e = a.position;
            else if (!a.seekable) throw new N(70);
            b = a.Ma.read(a, b, c, d, e);
            g || (a.position += b);
            return b;
          }
          function ma(a, b, c, d, e) {
            if (0 > d || 0 > e) throw new N(28);
            if (null === a.bb) throw new N(8);
            if (0 === (a.flags & 2097155)) throw new N(8);
            if (P(a.node.mode)) throw new N(31);
            if (!a.Ma.write) throw new N(28);
            a.seekable && a.flags & 1024 && Xb(a, 0, 2);
            var g = "undefined" != typeof e;
            if (!g) e = a.position;
            else if (!a.seekable) throw new N(70);
            b = a.Ma.write(a, b, c, d, e, void 0);
            g || (a.position += b);
            return b;
          }
          function sa(a) {
            var b = b || 0;
            var c = "binary";
            "utf8" !== c && "binary" !== c && Ja(`Invalid encoding type "${c}"`);
            b = la(a, b);
            a = Ub(a).size;
            var d = new Uint8Array(a);
            Yb(b, d, 0, a, 0);
            "utf8" === c && (d = db(d));
            na(b);
            return d;
          }
          function W(a, b, c) {
            a = ha("/dev/" + a);
            var d = ia(!!b, !!c);
            W.Rb ?? (W.Rb = 64);
            var e = W.Rb++ << 8 | 0;
            rb(e, { open(g) {
              g.seekable = false;
            }, close() {
              c?.buffer?.length && c(10);
            }, read(g, h, q, w) {
              for (var t = 0, x = 0; x < w; x++) {
                try {
                  var D = b();
                } catch (ib) {
                  throw new N(29);
                }
                if (void 0 === D && 0 === t) throw new N(6);
                if (null === D || void 0 === D) break;
                t++;
                h[q + x] = D;
              }
              t && (g.node.$a = Date.now());
              return t;
            }, write(g, h, q, w) {
              for (var t = 0; t < w; t++) try {
                c(h[q + t]);
              } catch (x) {
                throw new N(29);
              }
              w && (g.node.Ua = g.node.Ta = Date.now());
              return t;
            } });
            Rb(a, d, e);
          }
          var X = {};
          function Y(a, b, c) {
            if ("/" === b.charAt(0)) return b;
            a = -100 === a ? "/" : T(a).path;
            if (0 == b.length) {
              if (!c) throw new N(44);
              return a;
            }
            return a + "/" + b;
          }
          function Zb(a, b) {
            F[a >> 2] = b.cc;
            F[a + 4 >> 2] = b.mode;
            F[a + 8 >> 2] = b.rc;
            F[a + 12 >> 2] = b.uid;
            F[a + 16 >> 2] = b.nc;
            F[a + 20 >> 2] = b.nb;
            G[a + 24 >> 3] = BigInt(b.size);
            E[a + 32 >> 2] = 4096;
            E[a + 36 >> 2] = b.$b;
            var c = b.$a.getTime(), d = b.Ua.getTime(), e = b.Ta.getTime();
            G[a + 40 >> 3] = BigInt(Math.floor(c / 1e3));
            F[a + 48 >> 2] = c % 1e3 * 1e6;
            G[a + 56 >> 3] = BigInt(Math.floor(d / 1e3));
            F[a + 64 >> 2] = d % 1e3 * 1e6;
            G[a + 72 >> 3] = BigInt(Math.floor(e / 1e3));
            F[a + 80 >> 2] = e % 1e3 * 1e6;
            G[a + 88 >> 3] = BigInt(b.oc);
            return 0;
          }
          var ic = void 0, Ac = () => {
            var a = E[+ic >> 2];
            ic += 4;
            return a;
          }, Cc = 0, Dc = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335], Ec = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334], Fc = {}, Gc = (a) => {
            if (!(a instanceof Pa || "unwind" == a)) throw a;
          }, Hc = (a) => {
            Da = a;
            Va || 0 < Cc || (k.onExit?.(a), Ca = true);
            throw new Pa(a);
          }, Ic = (a) => {
            if (!Ca) try {
              a();
            } catch (b) {
              Gc(b);
            } finally {
              if (!(Va || 0 < Cc)) try {
                Da = a = Da, Hc(a);
              } catch (b) {
                Gc(b);
              }
            }
          }, Jc = {}, Lc = () => {
            if (!Kc) {
              var a = { USER: "web_user", LOGNAME: "web_user", PATH: ".", PWD: ".", HOME: "home/web_user", LANG: (globalThis.navigator?.language ?? "C").replace("-", "_") + ".UTF-8", _: va || "./this.program" }, b;
              for (b in Jc) void 0 === Jc[b] ? delete a[b] : a[b] = Jc[b];
              var c = [];
              for (b in a) c.push(`${b}=${a[b]}`);
              Kc = c;
            }
            return Kc;
          }, Kc, Mc = (a, b, c, d) => {
            var e = { string: (t) => {
              var x = 0;
              if (null !== t && void 0 !== t && 0 !== t) {
                x = gb(t) + 1;
                var D = y(x);
                M(t, C, D, x);
                x = D;
              }
              return x;
            }, array: (t) => {
              var x = y(t.length);
              m.set(t, x);
              return x;
            } };
            a = k["_" + a];
            var g = [], h = 0;
            if (d) for (var q = 0; q < d.length; q++) {
              var w = e[c[q]];
              w ? (0 === h && (h = oa()), g[q] = w(d[q])) : g[q] = d[q];
            }
            c = a(...g);
            return c = (function(t) {
              0 !== h && qa(h);
              return "string" === b ? z(t) : "boolean" === b ? !!t : t;
            })(c);
          }, ea = (a) => {
            var b = gb(a) + 1, c = ca(b);
            c && M(a, C, c, b);
            return c;
          }, Nc, Oc = [], A = (a) => {
            Nc.delete(Z.get(a));
            Z.set(a, null);
            Oc.push(a);
          }, Pc = (a) => {
            const b = a.length;
            return [b % 128 | 128, b >> 7, ...a];
          }, Qc = { i: 127, p: 127, j: 126, f: 125, d: 124, e: 111 }, Rc = (a) => Pc(Array.from(a, (b) => Qc[b])), ua = (a, b) => {
            if (!Nc) {
              Nc = /* @__PURE__ */ new WeakMap();
              var c = Z.length;
              if (Nc) for (var d = 0; d < 0 + c; d++) {
                var e = Z.get(d);
                e && Nc.set(e, d);
              }
            }
            if (c = Nc.get(a) || 0) return c;
            c = Oc.length ? Oc.pop() : Z.grow(1);
            try {
              Z.set(c, a);
            } catch (g) {
              if (!(g instanceof TypeError)) throw g;
              b = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, ...Pc([1, 96, ...Rc(b.slice(1)), ...Rc("v" === b[0] ? "" : b[0])]), 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);
              b = new WebAssembly.Module(b);
              b = new WebAssembly.Instance(b, { e: { f: a } }).exports.f;
              Z.set(c, b);
            }
            Nc.set(a, c);
            return c;
          };
          R = Array(4096);
          Pb(O, "/");
          U("/tmp");
          U("home");
          U("home/web_user");
          (function() {
            U("/dev");
            rb(259, { read: () => 0, write: (d, e, g, h) => h, Ya: () => 0 });
            Rb("/dev/null", 259);
            qb(1280, tb);
            qb(1536, ub);
            Rb("/dev/tty", 1280);
            Rb("/dev/tty1", 1536);
            var a = new Uint8Array(1024), b = 0, c = () => {
              0 === b && (bb(a), b = a.byteLength);
              return a[--b];
            };
            W("random", c);
            W("urandom", c);
            U("/dev/shm");
            U("/dev/shm/tmp");
          })();
          (function() {
            U("/proc");
            var a = U("/proc/self");
            U("/proc/self/fd");
            Pb({ ab() {
              var b = wb(a, "fd", 16895, 73);
              b.Ma = { Ya: O.Ma.Ya };
              b.La = { mb(c, d) {
                c = +d;
                var e = T(c);
                c = { parent: null, ab: { Sb: "fake" }, La: { eb: () => e.path }, id: c + 1 };
                return c.parent = c;
              }, Ib() {
                return Array.from(Bb.entries()).filter(([, c]) => c).map(([c]) => c.toString());
              } };
              return b;
            } }, "/proc/self/fd");
          })();
          k.noExitRuntime && (Va = k.noExitRuntime);
          k.print && (Aa = k.print);
          k.printErr && (B = k.printErr);
          k.wasmBinary && (Ba = k.wasmBinary);
          k.thisProgram && (va = k.thisProgram);
          if (k.preInit) for ("function" == typeof k.preInit && (k.preInit = [k.preInit]); 0 < k.preInit.length; ) k.preInit.shift()();
          k.stackSave = () => oa();
          k.stackRestore = (a) => qa(a);
          k.stackAlloc = (a) => y(a);
          k.cwrap = (a, b, c, d) => {
            var e = !c || c.every((g) => "number" === g || "boolean" === g);
            return "string" !== b && e && !d ? k["_" + a] : (...g) => Mc(a, b, c, g);
          };
          k.addFunction = ua;
          k.removeFunction = A;
          k.UTF8ToString = z;
          k.stringToNewUTF8 = ea;
          k.writeArrayToMemory = (a, b) => {
            m.set(a, b);
          };
          var ca, da, yb, Sc, qa, y, oa, Ia, Z, Tc = {
            a: (a, b, c, d) => Ja(`Assertion failed: ${z(a)}, at: ` + [b ? z(b) : "unknown filename", c, d ? z(d) : "unknown function"]),
            i: function(a, b) {
              try {
                return a = z(a), ka(a, b), 0;
              } catch (c) {
                if ("undefined" == typeof X || "ErrnoError" !== c.name) throw c;
                return -c.Pa;
              }
            },
            L: function(a, b, c) {
              try {
                b = z(b);
                b = Y(a, b);
                if (c & -8) return -28;
                var d = S(b, { hb: true }).node;
                if (!d) return -44;
                a = "";
                c & 4 && (a += "r");
                c & 2 && (a += "w");
                c & 1 && (a += "x");
                return a && Ib(d, a) ? -2 : 0;
              } catch (e) {
                if ("undefined" == typeof X || "ErrnoError" !== e.name) throw e;
                return -e.Pa;
              }
            },
            j: function(a, b) {
              try {
                var c = T(a);
                Vb(c, c.node, b, false);
                return 0;
              } catch (d) {
                if ("undefined" == typeof X || "ErrnoError" !== d.name) throw d;
                return -d.Pa;
              }
            },
            h: function(a) {
              try {
                var b = T(a);
                Ob(b, b.node, { timestamp: Date.now(), dc: false });
                return 0;
              } catch (c) {
                if ("undefined" == typeof X || "ErrnoError" !== c.name) throw c;
                return -c.Pa;
              }
            },
            b: function(a, b, c) {
              ic = c;
              try {
                var d = T(a);
                switch (b) {
                  case 0:
                    var e = Ac();
                    if (0 > e) break;
                    for (; Bb[e]; ) e++;
                    return Nb(d, e).bb;
                  case 1:
                  case 2:
                    return 0;
                  case 3:
                    return d.flags;
                  case 4:
                    return e = Ac(), d.flags |= e, 0;
                  case 12:
                    return e = Ac(), Ea[e + 0 >> 1] = 2, 0;
                  case 13:
                  case 14:
                    return 0;
                }
                return -28;
              } catch (g) {
                if ("undefined" == typeof X || "ErrnoError" !== g.name) throw g;
                return -g.Pa;
              }
            },
            g: function(a, b) {
              try {
                var c = T(a), d = c.node, e = c.Ma.Wa;
                a = e ? c : d;
                e ??= d.La.Wa;
                Lb(e);
                var g = e(a);
                return Zb(b, g);
              } catch (h) {
                if ("undefined" == typeof X || "ErrnoError" !== h.name) throw h;
                return -h.Pa;
              }
            },
            H: function(a, b) {
              b = -9007199254740992 > b || 9007199254740992 < b ? NaN : Number(b);
              try {
                if (isNaN(b)) return -61;
                var c = T(a);
                if (0 > b || 0 === (c.flags & 2097155)) throw new N(28);
                Wb(c, c.node, b);
                return 0;
              } catch (d) {
                if ("undefined" == typeof X || "ErrnoError" !== d.name) throw d;
                return -d.Pa;
              }
            },
            G: function(a, b) {
              try {
                if (0 === b) return -28;
                var c = gb("/") + 1;
                if (b < c) return -68;
                M("/", C, a, b);
                return c;
              } catch (d) {
                if ("undefined" == typeof X || "ErrnoError" !== d.name) throw d;
                return -d.Pa;
              }
            },
            K: function(a, b) {
              try {
                return a = z(a), Zb(b, Ub(a, true));
              } catch (c) {
                if ("undefined" == typeof X || "ErrnoError" !== c.name) throw c;
                return -c.Pa;
              }
            },
            C: function(a, b, c) {
              try {
                return b = z(b), b = Y(a, b), U(b, c), 0;
              } catch (d) {
                if ("undefined" == typeof X || "ErrnoError" !== d.name) throw d;
                return -d.Pa;
              }
            },
            J: function(a, b, c, d) {
              try {
                b = z(b);
                var e = d & 256;
                b = Y(a, b, d & 4096);
                return Zb(c, e ? Ub(b, true) : Ub(b));
              } catch (g) {
                if ("undefined" == typeof X || "ErrnoError" !== g.name) throw g;
                return -g.Pa;
              }
            },
            x: function(a, b, c, d) {
              ic = d;
              try {
                b = z(b);
                b = Y(a, b);
                var e = d ? Ac() : 0;
                return la(b, c, e).bb;
              } catch (g) {
                if ("undefined" == typeof X || "ErrnoError" !== g.name) throw g;
                return -g.Pa;
              }
            },
            v: function(a, b, c, d) {
              try {
                b = z(b);
                b = Y(a, b);
                if (0 >= d) return -28;
                var e = S(b).node;
                if (!e) throw new N(44);
                if (!e.La.eb) throw new N(28);
                var g = e.La.eb(e);
                var h = Math.min(d, gb(g)), q = m[c + h];
                M(g, C, c, d + 1);
                m[c + h] = q;
                return h;
              } catch (w) {
                if ("undefined" == typeof X || "ErrnoError" !== w.name) throw w;
                return -w.Pa;
              }
            },
            u: function(a) {
              try {
                return a = z(a), Tb(a), 0;
              } catch (b) {
                if ("undefined" == typeof X || "ErrnoError" !== b.name) throw b;
                return -b.Pa;
              }
            },
            f: function(a, b) {
              try {
                return a = z(a), Zb(b, Ub(a));
              } catch (c) {
                if ("undefined" == typeof X || "ErrnoError" !== c.name) throw c;
                return -c.Pa;
              }
            },
            r: function(a, b, c) {
              try {
                b = z(b);
                b = Y(a, b);
                if (c) if (512 === c) Tb(b);
                else return -28;
                else ta(b);
                return 0;
              } catch (d) {
                if ("undefined" == typeof X || "ErrnoError" !== d.name) throw d;
                return -d.Pa;
              }
            },
            q: function(a, b, c) {
              try {
                b = z(b);
                b = Y(a, b, true);
                var d = Date.now(), e, g;
                if (c) {
                  var h = F[c >> 2] + 4294967296 * E[c + 4 >> 2], q = E[c + 8 >> 2];
                  1073741823 == q ? e = d : 1073741822 == q ? e = null : e = 1e3 * h + q / 1e6;
                  c += 16;
                  h = F[c >> 2] + 4294967296 * E[c + 4 >> 2];
                  q = E[c + 8 >> 2];
                  1073741823 == q ? g = d : 1073741822 == q ? g = null : g = 1e3 * h + q / 1e6;
                } else g = e = d;
                if (null !== (g ?? e)) {
                  a = e;
                  var w = S(b, { hb: true }).node;
                  Lb(w.La.Xa)(w, { $a: a, Ua: g });
                }
                return 0;
              } catch (t) {
                if ("undefined" == typeof X || "ErrnoError" !== t.name) throw t;
                return -t.Pa;
              }
            },
            m: () => Ja(""),
            l: () => {
              Va = false;
              Cc = 0;
            },
            A: function(a, b) {
              a = -9007199254740992 > a || 9007199254740992 < a ? NaN : Number(a);
              a = new Date(1e3 * a);
              E[b >> 2] = a.getSeconds();
              E[b + 4 >> 2] = a.getMinutes();
              E[b + 8 >> 2] = a.getHours();
              E[b + 12 >> 2] = a.getDate();
              E[b + 16 >> 2] = a.getMonth();
              E[b + 20 >> 2] = a.getFullYear() - 1900;
              E[b + 24 >> 2] = a.getDay();
              var c = a.getFullYear();
              E[b + 28 >> 2] = (0 !== c % 4 || 0 === c % 100 && 0 !== c % 400 ? Ec : Dc)[a.getMonth()] + a.getDate() - 1 | 0;
              E[b + 36 >> 2] = -(60 * a.getTimezoneOffset());
              c = new Date(a.getFullYear(), 6, 1).getTimezoneOffset();
              var d = new Date(a.getFullYear(), 0, 1).getTimezoneOffset();
              E[b + 32 >> 2] = (c != d && a.getTimezoneOffset() == Math.min(d, c)) | 0;
            },
            y: function(a, b, c, d, e, g, h) {
              e = -9007199254740992 > e || 9007199254740992 < e ? NaN : Number(e);
              try {
                var q = T(d);
                if (0 !== (b & 2) && 0 === (c & 2) && 2 !== (q.flags & 2097155)) throw new N(2);
                if (1 === (q.flags & 2097155)) throw new N(2);
                if (!q.Ma.sb) throw new N(43);
                if (!a) throw new N(28);
                var w = q.Ma.sb(q, a, e, b, c);
                var t = w.tc;
                E[g >> 2] = w.Ub;
                F[h >> 2] = t;
                return 0;
              } catch (x) {
                if ("undefined" == typeof X || "ErrnoError" !== x.name) throw x;
                return -x.Pa;
              }
            },
            z: function(a, b, c, d, e, g) {
              g = -9007199254740992 > g || 9007199254740992 < g ? NaN : Number(g);
              try {
                var h = T(e);
                if (c & 2) {
                  if (32768 !== (h.node.mode & 61440)) throw new N(43);
                  d & 2 || h.Ma.tb && h.Ma.tb(h, C.slice(a, a + b), g, b, d);
                }
              } catch (q) {
                if ("undefined" == typeof X || "ErrnoError" !== q.name) throw q;
                return -q.Pa;
              }
            },
            n: (a, b) => {
              Fc[a] && (clearTimeout(Fc[a].id), delete Fc[a]);
              if (!b) return 0;
              var c = setTimeout(() => {
                delete Fc[a];
                Ic(() => Sc(a, performance.now()));
              }, b);
              Fc[a] = { id: c, Hc: b };
              return 0;
            },
            B: (a, b, c, d) => {
              var e = (/* @__PURE__ */ new Date()).getFullYear(), g = new Date(e, 0, 1).getTimezoneOffset();
              e = new Date(e, 6, 1).getTimezoneOffset();
              F[a >> 2] = 60 * Math.max(g, e);
              E[b >> 2] = Number(g != e);
              b = (h) => {
                var q = Math.abs(h);
                return `UTC${0 <= h ? "-" : "+"}${String(Math.floor(q / 60)).padStart(2, "0")}${String(q % 60).padStart(2, "0")}`;
              };
              a = b(g);
              b = b(e);
              e < g ? (M(a, C, c, 17), M(b, C, d, 17)) : (M(a, C, d, 17), M(b, C, c, 17));
            },
            d: () => Date.now(),
            s: () => 2147483648,
            c: () => performance.now(),
            o: (a) => {
              var b = C.length;
              a >>>= 0;
              if (2147483648 < a) return false;
              for (var c = 1; 4 >= c; c *= 2) {
                var d = b * (1 + 0.2 / c);
                d = Math.min(d, a + 100663296);
                a: {
                  d = (Math.min(2147483648, 65536 * Math.ceil(Math.max(a, d) / 65536)) - Ia.buffer.byteLength + 65535) / 65536 | 0;
                  try {
                    Ia.grow(d);
                    Ha();
                    var e = 1;
                    break a;
                  } catch (g) {
                  }
                  e = void 0;
                }
                if (e) return true;
              }
              return false;
            },
            E: (a, b) => {
              var c = 0, d = 0, e;
              for (e of Lc()) {
                var g = b + c;
                F[a + d >> 2] = g;
                c += M(e, C, g, Infinity) + 1;
                d += 4;
              }
              return 0;
            },
            F: (a, b) => {
              var c = Lc();
              F[a >> 2] = c.length;
              a = 0;
              for (var d of c) a += gb(d) + 1;
              F[b >> 2] = a;
              return 0;
            },
            e: function(a) {
              try {
                var b = T(a);
                na(b);
                return 0;
              } catch (c) {
                if ("undefined" == typeof X || "ErrnoError" !== c.name) throw c;
                return c.Pa;
              }
            },
            p: function(a, b) {
              try {
                var c = T(a);
                m[b] = c.Va ? 2 : P(c.mode) ? 3 : 40960 === (c.mode & 61440) ? 7 : 4;
                Ea[b + 2 >> 1] = 0;
                G[b + 8 >> 3] = BigInt(0);
                G[b + 16 >> 3] = BigInt(0);
                return 0;
              } catch (d) {
                if ("undefined" == typeof X || "ErrnoError" !== d.name) throw d;
                return d.Pa;
              }
            },
            w: function(a, b, c, d) {
              try {
                a: {
                  var e = T(a);
                  a = b;
                  for (var g, h = b = 0; h < c; h++) {
                    var q = F[a >> 2], w = F[a + 4 >> 2];
                    a += 8;
                    var t = Yb(e, m, q, w, g);
                    if (0 > t) {
                      var x = -1;
                      break a;
                    }
                    b += t;
                    if (t < w) break;
                    "undefined" != typeof g && (g += t);
                  }
                  x = b;
                }
                F[d >> 2] = x;
                return 0;
              } catch (D) {
                if ("undefined" == typeof X || "ErrnoError" !== D.name) throw D;
                return D.Pa;
              }
            },
            D: function(a, b, c, d) {
              b = -9007199254740992 > b || 9007199254740992 < b ? NaN : Number(b);
              try {
                if (isNaN(b)) return 61;
                var e = T(a);
                Xb(e, b, c);
                G[d >> 3] = BigInt(e.position);
                e.Eb && 0 === b && 0 === c && (e.Eb = null);
                return 0;
              } catch (g) {
                if ("undefined" == typeof X || "ErrnoError" !== g.name) throw g;
                return g.Pa;
              }
            },
            I: function(a) {
              try {
                var b = T(a);
                return b.Ma?.lb?.(b);
              } catch (c) {
                if ("undefined" == typeof X || "ErrnoError" !== c.name) throw c;
                return c.Pa;
              }
            },
            t: function(a, b, c, d) {
              try {
                a: {
                  var e = T(a);
                  a = b;
                  for (var g, h = b = 0; h < c; h++) {
                    var q = F[a >> 2], w = F[a + 4 >> 2];
                    a += 8;
                    var t = ma(e, m, q, w, g);
                    if (0 > t) {
                      var x = -1;
                      break a;
                    }
                    b += t;
                    if (t < w) break;
                    "undefined" != typeof g && (g += t);
                  }
                  x = b;
                }
                F[d >> 2] = x;
                return 0;
              } catch (D) {
                if ("undefined" == typeof X || "ErrnoError" !== D.name) throw D;
                return D.Pa;
              }
            },
            k: Hc
          };
          function Uc() {
            function a() {
              k.calledRun = true;
              if (!Ca) {
                if (!k.noFSInit && !Db) {
                  var b, c;
                  Db = true;
                  b ??= k.stdin;
                  c ??= k.stdout;
                  d ??= k.stderr;
                  b ? W("stdin", b) : Sb("/dev/tty", "/dev/stdin");
                  c ? W("stdout", null, c) : Sb("/dev/tty", "/dev/stdout");
                  d ? W("stderr", null, d) : Sb("/dev/tty1", "/dev/stderr");
                  la("/dev/stdin", 0);
                  la("/dev/stdout", 1);
                  la("/dev/stderr", 1);
                }
                Vc.N();
                Eb = false;
                k.onRuntimeInitialized?.();
                if (k.postRun) for ("function" == typeof k.postRun && (k.postRun = [k.postRun]); k.postRun.length; ) {
                  var d = k.postRun.shift();
                  Ra.push(d);
                }
                Qa(Ra);
              }
            }
            if (0 < J) Ua = Uc;
            else {
              if (k.preRun) for ("function" == typeof k.preRun && (k.preRun = [k.preRun]); k.preRun.length; ) Ta();
              Qa(Sa);
              0 < J ? Ua = Uc : k.setStatus ? (k.setStatus("Running..."), setTimeout(() => {
                setTimeout(() => k.setStatus(""), 1);
                a();
              }, 1)) : a();
            }
          }
          var Vc;
          (async function() {
            function a(c) {
              c = Vc = c.exports;
              k._sqlite3_free = c.P;
              k._sqlite3_value_text = c.Q;
              k._sqlite3_prepare_v2 = c.R;
              k._sqlite3_step = c.S;
              k._sqlite3_reset = c.T;
              k._sqlite3_exec = c.U;
              k._sqlite3_finalize = c.V;
              k._sqlite3_column_name = c.W;
              k._sqlite3_column_text = c.X;
              k._sqlite3_column_type = c.Y;
              k._sqlite3_errmsg = c.Z;
              k._sqlite3_clear_bindings = c._;
              k._sqlite3_value_blob = c.$;
              k._sqlite3_value_bytes = c.aa;
              k._sqlite3_value_double = c.ba;
              k._sqlite3_value_int = c.ca;
              k._sqlite3_value_type = c.da;
              k._sqlite3_result_blob = c.ea;
              k._sqlite3_result_double = c.fa;
              k._sqlite3_result_error = c.ga;
              k._sqlite3_result_int = c.ha;
              k._sqlite3_result_int64 = c.ia;
              k._sqlite3_result_null = c.ja;
              k._sqlite3_result_text = c.ka;
              k._sqlite3_aggregate_context = c.la;
              k._sqlite3_column_count = c.ma;
              k._sqlite3_data_count = c.na;
              k._sqlite3_column_blob = c.oa;
              k._sqlite3_column_bytes = c.pa;
              k._sqlite3_column_double = c.qa;
              k._sqlite3_bind_blob = c.ra;
              k._sqlite3_bind_double = c.sa;
              k._sqlite3_bind_int = c.ta;
              k._sqlite3_bind_text = c.ua;
              k._sqlite3_bind_parameter_index = c.va;
              k._sqlite3_sql = c.wa;
              k._sqlite3_normalized_sql = c.xa;
              k._sqlite3_changes = c.ya;
              k._sqlite3_close_v2 = c.za;
              k._sqlite3_create_function_v2 = c.Aa;
              k._sqlite3_update_hook = c.Ba;
              k._sqlite3_open = c.Ca;
              ca = k._malloc = c.Da;
              da = k._free = c.Ea;
              k._RegisterExtensionFunctions = c.Fa;
              yb = c.Ga;
              Sc = c.Ha;
              qa = c.Ia;
              y = c.Ja;
              oa = c.Ka;
              Ia = c.M;
              Z = c.O;
              Ha();
              J--;
              k.monitorRunDependencies?.(J);
              0 == J && Ua && (c = Ua, Ua = null, c());
              return Vc;
            }
            J++;
            k.monitorRunDependencies?.(J);
            var b = { a: Tc };
            if (k.instantiateWasm) return new Promise((c) => {
              k.instantiateWasm(b, (d, e) => {
                c(a(d, e));
              });
            });
            La ??= k.locateFile ? k.locateFile("sql-wasm-browser.wasm", xa) : xa + "sql-wasm-browser.wasm";
            return a((await Oa(b)).instance);
          })();
          Uc();
          return Module;
        });
        return initSqlJsPromise;
      };
      if (typeof exports === "object" && typeof module === "object") {
        module.exports = initSqlJs2;
        module.exports.default = initSqlJs2;
      } else if (typeof define === "function" && define["amd"]) {
        define([], function() {
          return initSqlJs2;
        });
      } else if (typeof exports === "object") {
        exports["Module"] = initSqlJs2;
      }
    }
  });

  // src/atlas-db-runtime.ts
  var import_sql = __toESM(require_sql_wasm_browser(), 1);

  // src/atlas-db-schema.ts
  var ATLAS_SCHEMA_VERSION = 1;
  var C_COLUMNS = [
    { name: "branch_id", nullable: false },
    { name: "id", nullable: false },
    { name: "row_rev", nullable: false },
    { name: "created_turn_id", nullable: false },
    { name: "updated_turn_id", nullable: false }
  ];
  function col(name, nullable = true) {
    return { name, nullable };
  }
  function cols(...names) {
    return names.map((n) => col(n));
  }
  function notNull(...names) {
    return names.map((n) => ({ name: n, nullable: false }));
  }
  var ATLAS_TABLE_COLUMNS = {
    maps: [
      ...C_COLUMNS,
      ...notNull("name", "kind", "frame_json", "scale_quality", "scale_basis_json", "scale_locked", "calibration_rev", "default_terrain", "status"),
      ...cols("container_location_id", "description", "meters_per_cell", "scale_min_meters_per_cell", "scale_max_meters_per_cell", "background_asset_key")
    ],
    locations: [
      ...C_COLUMNS,
      ...notNull("name", "aliases_json", "kind", "mobility", "coord_precision", "terrain", "existence_quality", "status"),
      ...cols("description", "parent_location_id", "anchor_location_id", "map_id", "grid_x", "grid_y", "uncertainty_radius_cells", "area_geometry_json", "access_rules_json", "vehicle_profile_json", "merged_into_id")
    ],
    characters: [
      ...C_COLUMNS,
      ...notNull("name", "aliases_json", "role", "importance", "physical_status", "coord_precision", "mobility_profiles_json", "capabilities_json", "status"),
      ...cols("identity", "description", "personality", "importance_reason", "thought", "action_tendency", "condition_note", "location_id", "map_id", "grid_x", "grid_y", "uncertainty_radius_cells", "merged_into_id")
    ],
    items: [
      ...C_COLUMNS,
      ...notNull("name", "aliases_json", "kind", "unit", "coord_precision", "properties_json", "status"),
      ...cols("description", "quantity", "condition_note", "owner_entity_id", "holder_character_id", "container_item_id", "location_id", "map_id", "grid_x", "grid_y", "uncertainty_radius_cells", "merged_into_id")
    ],
    factions: [
      ...C_COLUMNS,
      ...notNull("name", "aliases_json", "kind", "capabilities_json", "status"),
      ...cols("description", "goal", "headquarters_location_id", "merged_into_id")
    ],
    relations: [
      ...C_COLUMNS,
      ...notNull("subject_entity_id", "object_entity_id", "kind", "label", "attitude", "trust", "basis_quality", "secrecy", "valid_from_s", "status"),
      ...cols("description", "valid_until_s")
    ],
    routes: [
      ...C_COLUMNS,
      ...notNull("from_location_id", "to_location_id", "kind", "bidirectional", "geometry_quality", "geometry_rev", "distance_basis", "terrain", "allowed_modes_json", "status"),
      ...cols("map_id", "geometry_json", "distance_m", "distance_min_m", "distance_max_m", "access_rules_json", "travel_time_override_json", "status_reason")
    ],
    actions: [
      ...C_COLUMNS,
      ...notNull("actor_entity_id", "kind", "title", "intent", "depends_on_json", "progress_s", "evaluated_until_s", "secrecy", "priority", "status"),
      ...cols("parent_action_id", "target_entity_id", "target_location_id", "target_event_id", "trigger_json", "payload_json", "duration_json", "earliest_start_s", "deadline_s", "next_check_s", "started_at_s", "finished_at_s", "reason_code", "result_event_id")
    ],
    journeys: [
      ...C_COLUMNS,
      ...notNull("action_id", "mover_entity_id", "origin_location_id", "destination_location_id", "segments_json", "segment_index", "segment_time_done_s", "started_at_s", "last_advanced_at_s", "position_quality", "status"),
      ...cols("segment_distance_done_m", "last_reached_location_id", "stop_location_id", "estimated_arrival_min_s", "estimated_arrival_max_s", "arrived_at_s", "stop_reason")
    ],
    events: [
      ...C_COLUMNS,
      ...notNull("title", "kind", "summary", "participants_json", "secrecy", "status"),
      ...cols("location_id", "route_id", "route_progress_m", "subject_entity_id", "cause_action_id", "parent_event_id", "scheduled_start_s", "trigger_json", "occurred_at_s", "ended_at_s", "outcome")
    ],
    information: [
      ...C_COLUMNS,
      ...notNull("kind", "title", "content", "truth_status", "secrecy", "topic_key", "content_hash", "created_at_s", "status"),
      ...cols("source_event_id", "subject_entity_id", "payload_json", "origin_location_id", "originator_entity_id", "parent_information_id", "expires_at_s", "supersedes_information_id")
    ],
    rumor_fronts: [
      ...C_COLUMNS,
      ...notNull("information_id", "location_id", "first_available_at_s", "last_reinforced_at_s", "reach", "audience_json", "status"),
      ...cols("via_channel_id", "source_front_id", "source_action_id", "next_spread_check_s", "expires_at_s")
    ],
    knowledge: [
      ...C_COLUMNS,
      ...notNull("is_pov", "information_id", "first_received_at_s", "belief", "attention", "status"),
      ...cols("knower_character_id", "knower_faction_id", "source_entity_id", "source_front_id", "source_channel_id", "last_confirmed_at_s", "reaction_note")
    ],
    channels: [
      ...C_COLUMNS,
      ...notNull("name", "kind", "owner_entity_id", "scope_json", "latency_json", "reliability", "secrecy", "basis_quality", "valid_from_s", "status"),
      ...cols("source_entity_id", "source_location_id", "recipient_entity_id", "recipient_location_id", "requirements_json", "transport_mode_key", "valid_until_s")
    ],
    entity_keys: [col("branch_id", false), col("id", false), col("kind", false)],
    branches: [
      ...notNull("id", "revision", "name", "clock_s", "clock_min_s", "clock_max_s", "simulation_cursor_s", "simulation_status", "ruleset_version", "status", "created_wall_ms"),
      ...cols("parent_branch_id", "fork_turn_id", "head_turn_id", "pov_character_id", "root_map_id", "calendar_label")
    ],
    turns: [
      ...notNull("id", "branch_id", "kind", "input_hash", "base_revision", "clock_before_s", "elapsed_json", "clock_after_s", "rng_seed", "ruleset_version", "decisions_json", "attempts_json", "status", "created_wall_ms"),
      ...cols("parent_turn_id", "host_message_uid", "host_variant_key", "story_hash", "committed_revision", "receipt_json", "prepared_wall_ms")
    ],
    turn_changes: [
      ...notNull("id", "turn_id", "sequence", "attempt_id", "group_id", "operation_id", "target_table", "target_row_id", "operation", "basis_json", "summary"),
      ...cols("before_json", "after_json")
    ],
    mention_candidates: [
      ...notNull("branch_id", "id", "name", "normalized_name", "context_key", "kind_hint", "first_turn_id", "last_turn_id", "distinct_turn_count", "recent_turn_ids_json", "context_summary", "lorebook_source_keys_json", "importance_hint", "status"),
      ...cols("promoted_entity_id")
    ],
    sync_outbox: [
      ...notNull("id", "branch_id", "target", "projection_scope", "target_revision", "idempotency_key", "payload_hash", "status", "attempt_count", "created_wall_ms"),
      ...cols("requested_by_turn_id", "next_retry_wall_ms", "last_error_code", "last_error_message", "completed_wall_ms")
    ]
  };
  function tableColumnNames(table) {
    return ATLAS_TABLE_COLUMNS[table].map((c) => c.name);
  }
  function isKnownTable(name) {
    return Object.prototype.hasOwnProperty.call(ATLAS_TABLE_COLUMNS, name);
  }
  function commonColumnsSql() {
    return `  branch_id TEXT NOT NULL,
  id TEXT NOT NULL,
  row_rev INTEGER NOT NULL DEFAULT 1 CHECK (row_rev >= 1),
  created_turn_id TEXT NOT NULL,
  updated_turn_id TEXT NOT NULL`;
  }
  function businessPrimaryKeySql() {
    return "  PRIMARY KEY (branch_id, id)";
  }
  function entityKeyFk() {
    return "  FOREIGN KEY (branch_id, id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED";
  }
  var COMMON_TURN_FKS = `  FOREIGN KEY (branch_id, created_turn_id) REFERENCES turns(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, updated_turn_id) REFERENCES turns(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED`;
  function entityKeysSql() {
    return `CREATE TABLE IF NOT EXISTS entity_keys (
  branch_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('location','character','item','faction')),
  PRIMARY KEY (branch_id, id)
)`;
  }
  function branchesSql() {
    return `CREATE TABLE IF NOT EXISTS branches (
  id TEXT NOT NULL PRIMARY KEY,
  parent_branch_id TEXT,
  fork_turn_id TEXT,
  head_turn_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  pov_character_id TEXT,
  root_map_id TEXT,
  clock_s REAL NOT NULL DEFAULT 0,
  clock_min_s REAL NOT NULL DEFAULT 0,
  clock_max_s REAL NOT NULL DEFAULT 0,
  calendar_label TEXT,
  simulation_cursor_s REAL NOT NULL DEFAULT 0,
  simulation_status TEXT NOT NULL DEFAULT 'current' CHECK (simulation_status IN ('current','catching_up','blocked')),
  ruleset_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_wall_ms INTEGER NOT NULL,
  CHECK (clock_min_s <= clock_s),
  CHECK (clock_s <= clock_max_s),
  CHECK (clock_min_s >= 0 AND clock_max_s >= 0 AND simulation_cursor_s >= 0),
  FOREIGN KEY (parent_branch_id) REFERENCES branches(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (fork_turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (head_turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
)`;
  }
  function turnsSql() {
    return `CREATE TABLE IF NOT EXISTS turns (
  id TEXT NOT NULL PRIMARY KEY,
  branch_id TEXT NOT NULL,
  parent_turn_id TEXT,
  host_message_uid TEXT,
  host_variant_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('narrative','manual','migration','background','fork')),
  input_hash TEXT NOT NULL,
  story_hash TEXT,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  committed_revision INTEGER,
  clock_before_s REAL NOT NULL,
  elapsed_json TEXT NOT NULL,
  clock_after_s REAL NOT NULL,
  rng_seed TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  receipt_json TEXT,
  attempts_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','committed','partial','failed','rolled_back')),
  created_wall_ms INTEGER NOT NULL,
  prepared_wall_ms INTEGER,
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (parent_turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (committed_revision IS NULL OR committed_revision >= base_revision)
)`;
  }
  function entityKindTrigger(table, kind) {
    return `CREATE TRIGGER IF NOT EXISTS trg_${table}_entity_kind_insert
BEFORE INSERT ON ${table}
FOR EACH ROW
WHEN COALESCE((SELECT kind FROM entity_keys WHERE branch_id = NEW.branch_id AND id = NEW.id), '') <> '${kind}'
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_KEY_KIND_MISMATCH: ${table}');
END`;
  }
  function entityKindTriggerUpdate(table, kind) {
    return `CREATE TRIGGER IF NOT EXISTS trg_${table}_entity_kind_update
BEFORE UPDATE ON ${table}
FOR EACH ROW
WHEN COALESCE((SELECT kind FROM entity_keys WHERE branch_id = NEW.branch_id AND id = NEW.id), '') <> '${kind}'
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_KEY_KIND_MISMATCH: ${table}');
END`;
  }
  function mapsSql() {
    return `CREATE TABLE IF NOT EXISTS maps (
  ${commonColumnsSql()},
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('world','region','site','interior')),
  container_location_id TEXT,
  description TEXT NOT NULL DEFAULT '',
  frame_json TEXT NOT NULL,
  meters_per_cell REAL CHECK (meters_per_cell IS NULL OR meters_per_cell > 0),
  scale_min_meters_per_cell REAL CHECK (scale_min_meters_per_cell IS NULL OR scale_min_meters_per_cell > 0),
  scale_max_meters_per_cell REAL CHECK (scale_max_meters_per_cell IS NULL OR scale_max_meters_per_cell > 0),
  scale_quality TEXT NOT NULL CHECK (scale_quality IN ('uncalibrated','estimated','confirmed')),
  scale_basis_json TEXT NOT NULL DEFAULT '',
  scale_locked INTEGER NOT NULL DEFAULT 0 CHECK (scale_locked IN (0,1)),
  calibration_rev INTEGER NOT NULL DEFAULT 1 CHECK (calibration_rev >= 1),
  background_asset_key TEXT,
  default_terrain TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, container_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (scale_min_meters_per_cell IS NULL OR meters_per_cell IS NULL OR scale_min_meters_per_cell <= meters_per_cell),
  CHECK (scale_max_meters_per_cell IS NULL OR meters_per_cell IS NULL OR meters_per_cell <= scale_max_meters_per_cell)
)`;
  }
  function locationsSql() {
    return `CREATE TABLE IF NOT EXISTS locations (
  ${commonColumnsSql()},
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL CHECK (kind IN ('region','city','district','building','room','natural','vehicle','other')),
  description TEXT NOT NULL DEFAULT '',
  parent_location_id TEXT,
  mobility TEXT NOT NULL DEFAULT 'fixed' CHECK (mobility IN ('fixed','mobile')),
  anchor_location_id TEXT,
  map_id TEXT,
  grid_x REAL,
  grid_y REAL,
  coord_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (coord_precision IN ('exact','approximate','layout','unknown')),
  uncertainty_radius_cells REAL,
  area_geometry_json TEXT,
  terrain TEXT NOT NULL DEFAULT 'unknown',
  access_rules_json TEXT,
  vehicle_profile_json TEXT,
  existence_quality TEXT NOT NULL DEFAULT 'confirmed' CHECK (existence_quality IN ('confirmed','inferred','hypothetical')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','destroyed','merged','archived')),
  merged_into_id TEXT,
  ${businessPrimaryKeySql()},
  ${entityKeyFk()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, parent_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, anchor_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, merged_into_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, map_id) REFERENCES maps(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ((grid_x IS NULL) = (grid_y IS NULL)),
  CHECK (grid_x IS NULL OR grid_y IS NULL OR (grid_x = grid_x AND grid_y = grid_y)),
  CHECK (grid_x IS NULL OR map_id IS NOT NULL),
  CHECK (parent_location_id IS NULL OR parent_location_id <> id),
  CHECK (uncertainty_radius_cells IS NULL OR uncertainty_radius_cells >= 0),
  CHECK (existence_quality <> 'hypothetical' OR status <> 'destroyed')
)`;
  }
  function charactersSql() {
    return `CREATE TABLE IF NOT EXISTS characters (
  ${commonColumnsSql()},
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  role TEXT NOT NULL DEFAULT 'npc' CHECK (role IN ('protagonist','companion','npc')),
  identity TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  importance TEXT NOT NULL DEFAULT 'supporting' CHECK (importance IN ('core','recurring','supporting')),
  importance_reason TEXT NOT NULL DEFAULT '',
  thought TEXT NOT NULL DEFAULT '',
  action_tendency TEXT NOT NULL DEFAULT '',
  physical_status TEXT NOT NULL DEFAULT 'unknown' CHECK (physical_status IN ('alive','incapacitated','dead','unknown')),
  condition_note TEXT NOT NULL DEFAULT '',
  location_id TEXT,
  map_id TEXT,
  grid_x REAL,
  grid_y REAL,
  coord_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (coord_precision IN ('exact','approximate','unknown')),
  uncertainty_radius_cells REAL,
  mobility_profiles_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','merged')),
  merged_into_id TEXT,
  ${businessPrimaryKeySql()},
  ${entityKeyFk()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, merged_into_id) REFERENCES characters(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, map_id) REFERENCES maps(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ((grid_x IS NULL) = (grid_y IS NULL)),
  CHECK (grid_x IS NULL OR map_id IS NOT NULL),
  CHECK (coord_precision <> 'layout'),
  CHECK (uncertainty_radius_cells IS NULL OR uncertainty_radius_cells >= 0)
)`;
  }
  function itemsSql() {
    return `CREATE TABLE IF NOT EXISTS items (
  ${commonColumnsSql()},
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('object','resource','document','equipment','container','other')),
  description TEXT NOT NULL DEFAULT '',
  quantity REAL CHECK (quantity IS NULL OR quantity >= 0),
  unit TEXT NOT NULL DEFAULT '件',
  condition_note TEXT NOT NULL DEFAULT '',
  owner_entity_id TEXT,
  holder_character_id TEXT,
  container_item_id TEXT,
  location_id TEXT,
  map_id TEXT,
  grid_x REAL,
  grid_y REAL,
  coord_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (coord_precision IN ('exact','approximate','unknown')),
  uncertainty_radius_cells REAL,
  properties_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','destroyed','lost','merged','archived')),
  merged_into_id TEXT,
  ${businessPrimaryKeySql()},
  ${entityKeyFk()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, owner_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, holder_character_id) REFERENCES characters(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, container_item_id) REFERENCES items(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, map_id) REFERENCES maps(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, merged_into_id) REFERENCES items(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ((holder_character_id IS NOT NULL) + (container_item_id IS NOT NULL) + (location_id IS NOT NULL) <= 1),
  CHECK ((grid_x IS NULL) = (grid_y IS NULL)),
  CHECK (grid_x IS NULL OR map_id IS NOT NULL),
  CHECK (container_item_id IS NULL OR container_item_id <> id),
  CHECK (uncertainty_radius_cells IS NULL OR uncertainty_radius_cells >= 0)
)`;
  }
  function factionsSql() {
    return `CREATE TABLE IF NOT EXISTS factions (
  ${commonColumnsSql()},
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('nation','organization','family','team','other')),
  description TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  headquarters_location_id TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dissolved','merged','archived')),
  merged_into_id TEXT,
  ${businessPrimaryKeySql()},
  ${entityKeyFk()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, headquarters_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, merged_into_id) REFERENCES factions(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
)`;
  }
  function relationsSql() {
    return `CREATE TABLE IF NOT EXISTS relations (
  ${commonColumnsSql()},
  subject_entity_id TEXT NOT NULL,
  object_entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('member_of','leads','controls','knows','kinship','ally','hostile','owes','protects','other')),
  label TEXT NOT NULL DEFAULT '',
  attitude TEXT NOT NULL DEFAULT 'unknown' CHECK (attitude IN ('supportive','neutral','suspicious','hostile','unknown')),
  trust TEXT NOT NULL DEFAULT 'unknown' CHECK (trust IN ('high','medium','low','unknown')),
  description TEXT NOT NULL DEFAULT '',
  basis_quality TEXT NOT NULL DEFAULT 'inferred' CHECK (basis_quality IN ('confirmed','inferred')),
  secrecy TEXT NOT NULL DEFAULT 'restricted' CHECK (secrecy IN ('public','restricted','secret')),
  valid_from_s REAL NOT NULL DEFAULT 0,
  valid_until_s REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','disputed')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, subject_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, object_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (subject_entity_id <> object_entity_id),
  CHECK (valid_until_s IS NULL OR valid_until_s >= valid_from_s)
)`;
  }
  function routesSql() {
    return `CREATE TABLE IF NOT EXISTS routes (
  ${commonColumnsSql()},
  from_location_id TEXT NOT NULL,
  to_location_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('adjacent','road','path','door','stairs','air','water','portal','estimated')),
  bidirectional INTEGER NOT NULL DEFAULT 1 CHECK (bidirectional IN (0,1)),
  map_id TEXT,
  geometry_json TEXT,
  geometry_quality TEXT NOT NULL DEFAULT 'unknown' CHECK (geometry_quality IN ('confirmed','estimated','unknown')),
  geometry_rev INTEGER NOT NULL DEFAULT 1 CHECK (geometry_rev >= 1),
  distance_m REAL CHECK (distance_m IS NULL OR distance_m >= 0),
  distance_min_m REAL CHECK (distance_min_m IS NULL OR distance_min_m >= 0),
  distance_max_m REAL CHECK (distance_max_m IS NULL OR distance_max_m >= 0),
  distance_basis TEXT NOT NULL DEFAULT 'unknown' CHECK (distance_basis IN ('measured','calibrated','narrative','estimated','unknown')),
  terrain TEXT NOT NULL DEFAULT 'unknown',
  allowed_modes_json TEXT NOT NULL DEFAULT '[]',
  access_rules_json TEXT,
  travel_time_override_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','blocked','closed')),
  status_reason TEXT NOT NULL DEFAULT '',
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, from_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, to_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, map_id) REFERENCES maps(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (from_location_id <> to_location_id),
  CHECK (distance_min_m IS NULL OR distance_m IS NULL OR distance_min_m <= distance_m),
  CHECK (distance_max_m IS NULL OR distance_m IS NULL OR distance_m <= distance_max_m),
  CHECK (distance_min_m IS NULL OR distance_max_m IS NULL OR distance_min_m <= distance_max_m)
)`;
  }
  function actionsSql() {
    return `CREATE TABLE IF NOT EXISTS actions (
  ${commonColumnsSql()},
  actor_entity_id TEXT NOT NULL,
  parent_action_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('goal','prepare','travel','wait','interact','transmit','investigate','act')),
  title TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL DEFAULT '',
  target_entity_id TEXT,
  target_location_id TEXT,
  target_event_id TEXT,
  trigger_json TEXT,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT,
  duration_json TEXT,
  progress_s REAL NOT NULL DEFAULT 0 CHECK (progress_s >= 0),
  earliest_start_s REAL,
  deadline_s REAL,
  next_check_s REAL,
  started_at_s REAL,
  finished_at_s REAL,
  evaluated_until_s REAL NOT NULL DEFAULT 0,
  secrecy TEXT NOT NULL DEFAULT 'restricted' CHECK (secrecy IN ('public','restricted','secret')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','ready','active','paused','blocked','completed','failed','cancelled')),
  reason_code TEXT,
  result_event_id TEXT,
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, actor_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, parent_action_id) REFERENCES actions(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, target_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, target_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, target_event_id) REFERENCES events(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, result_event_id) REFERENCES events(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (parent_action_id IS NULL OR parent_action_id <> id),
  CHECK (finished_at_s IS NULL OR started_at_s IS NULL OR finished_at_s >= started_at_s)
)`;
  }
  function journeysSql() {
    return `CREATE TABLE IF NOT EXISTS journeys (
  ${commonColumnsSql()},
  action_id TEXT NOT NULL,
  mover_entity_id TEXT NOT NULL,
  origin_location_id TEXT NOT NULL,
  destination_location_id TEXT NOT NULL,
  segments_json TEXT NOT NULL DEFAULT '[]',
  segment_index INTEGER NOT NULL DEFAULT 0 CHECK (segment_index >= 0),
  segment_distance_done_m REAL CHECK (segment_distance_done_m IS NULL OR segment_distance_done_m >= 0),
  segment_time_done_s REAL NOT NULL DEFAULT 0 CHECK (segment_time_done_s >= 0),
  last_reached_location_id TEXT,
  stop_location_id TEXT,
  started_at_s REAL NOT NULL,
  last_advanced_at_s REAL NOT NULL,
  estimated_arrival_min_s REAL,
  estimated_arrival_max_s REAL,
  arrived_at_s REAL,
  position_quality TEXT NOT NULL DEFAULT 'unlocated' CHECK (position_quality IN ('route_confirmed','route_estimated','unlocated')),
  status TEXT NOT NULL DEFAULT 'moving' CHECK (status IN ('moving','paused','arrived','cancelled','blocked')),
  stop_reason TEXT,
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, action_id) REFERENCES actions(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, mover_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, origin_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, destination_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, last_reached_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, stop_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (last_advanced_at_s >= started_at_s),
  CHECK (estimated_arrival_min_s IS NULL OR estimated_arrival_max_s IS NULL OR estimated_arrival_min_s <= estimated_arrival_max_s),
  CHECK (status <> 'moving' OR stop_location_id IS NULL)
)`;
  }
  function eventsSql() {
    return `CREATE TABLE IF NOT EXISTS events (
  ${commonColumnsSql()},
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('ceremony','conflict','arrival','passage','discovery','trade','communication','incident','other')),
  summary TEXT NOT NULL DEFAULT '',
  location_id TEXT,
  route_id TEXT,
  route_progress_m REAL CHECK (route_progress_m IS NULL OR route_progress_m >= 0),
  subject_entity_id TEXT,
  participants_json TEXT NOT NULL DEFAULT '[]',
  cause_action_id TEXT,
  parent_event_id TEXT,
  scheduled_start_s REAL,
  trigger_json TEXT,
  occurred_at_s REAL,
  ended_at_s REAL,
  outcome TEXT NOT NULL DEFAULT '',
  secrecy TEXT NOT NULL DEFAULT 'restricted' CHECK (secrecy IN ('public','restricted','secret')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','ongoing','occurred','cancelled')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, route_id) REFERENCES routes(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, subject_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, cause_action_id) REFERENCES actions(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, parent_event_id) REFERENCES events(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (parent_event_id IS NULL OR parent_event_id <> id),
  CHECK (status NOT IN ('occurred','ongoing') OR occurred_at_s IS NOT NULL),
  CHECK (ended_at_s IS NULL OR occurred_at_s IS NULL OR ended_at_s >= occurred_at_s)
)`;
  }
  function informationSql() {
    return `CREATE TABLE IF NOT EXISTS information (
  ${commonColumnsSql()},
  kind TEXT NOT NULL DEFAULT 'observation' CHECK (kind IN ('observation','report','rumor','announcement','lie','hypothesis')),
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  source_event_id TEXT,
  subject_entity_id TEXT,
  payload_json TEXT,
  origin_location_id TEXT,
  originator_entity_id TEXT,
  parent_information_id TEXT,
  truth_status TEXT NOT NULL DEFAULT 'unknown' CHECK (truth_status IN ('true','false','mixed','unknown')),
  secrecy TEXT NOT NULL DEFAULT 'restricted' CHECK (secrecy IN ('public','restricted','secret')),
  topic_key TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  created_at_s REAL NOT NULL,
  expires_at_s REAL,
  supersedes_information_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retracted','archived')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, source_event_id) REFERENCES events(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, subject_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, origin_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, originator_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, parent_information_id) REFERENCES information(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, supersedes_information_id) REFERENCES information(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (parent_information_id IS NULL OR parent_information_id <> id),
  CHECK (expires_at_s IS NULL OR expires_at_s >= created_at_s)
)`;
  }
  function rumorFrontsSql() {
    return `CREATE TABLE IF NOT EXISTS rumor_fronts (
  ${commonColumnsSql()},
  information_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  via_channel_id TEXT,
  source_front_id TEXT,
  source_action_id TEXT,
  first_available_at_s REAL NOT NULL,
  last_reinforced_at_s REAL NOT NULL,
  next_spread_check_s REAL,
  expires_at_s REAL,
  reach TEXT NOT NULL DEFAULT 'local' CHECK (reach IN ('isolated','local','widespread')),
  audience_json TEXT NOT NULL DEFAULT '{"access":"public","tags":[]}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','fading','ended')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, information_id) REFERENCES information(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, via_channel_id) REFERENCES channels(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_front_id) REFERENCES rumor_fronts(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_action_id) REFERENCES actions(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (source_front_id IS NULL OR source_front_id <> id),
  CHECK (expires_at_s IS NULL OR expires_at_s >= first_available_at_s)
)`;
  }
  function knowledgeSql() {
    return `CREATE TABLE IF NOT EXISTS knowledge (
  ${commonColumnsSql()},
  knower_character_id TEXT,
  knower_faction_id TEXT,
  is_pov INTEGER NOT NULL DEFAULT 0 CHECK (is_pov IN (0,1)),
  information_id TEXT NOT NULL,
  source_entity_id TEXT,
  source_front_id TEXT,
  source_channel_id TEXT,
  first_received_at_s REAL NOT NULL,
  last_confirmed_at_s REAL,
  belief TEXT NOT NULL DEFAULT 'heard' CHECK (belief IN ('heard','doubted','believed','verified','rejected')),
  attention TEXT NOT NULL DEFAULT 'normal' CHECK (attention IN ('low','normal','high')),
  reaction_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','outdated','forgotten')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, knower_character_id) REFERENCES characters(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, knower_faction_id) REFERENCES factions(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, information_id) REFERENCES information(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_front_id) REFERENCES rumor_fronts(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_channel_id) REFERENCES channels(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ((knower_character_id IS NOT NULL) + (knower_faction_id IS NOT NULL) + (is_pov = 1) = 1),
  CHECK (last_confirmed_at_s IS NULL OR last_confirmed_at_s >= first_received_at_s)
)`;
  }
  function channelsSql() {
    return `CREATE TABLE IF NOT EXISTS channels (
  ${commonColumnsSql()},
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('contact','faction_network','messenger','surveillance','broadcast','magic','other')),
  owner_entity_id TEXT NOT NULL,
  source_entity_id TEXT,
  source_location_id TEXT,
  recipient_entity_id TEXT,
  recipient_location_id TEXT,
  scope_json TEXT NOT NULL DEFAULT '{"location_refs":[],"entity_refs":[],"topics":[]}',
  requirements_json TEXT,
  latency_json TEXT NOT NULL DEFAULT '{"quality":"unknown","basis_refs":[]}',
  transport_mode_key TEXT,
  reliability TEXT NOT NULL DEFAULT 'unknown' CHECK (reliability IN ('high','medium','low','unknown')),
  secrecy TEXT NOT NULL DEFAULT 'restricted' CHECK (secrecy IN ('public','restricted','secret')),
  basis_quality TEXT NOT NULL DEFAULT 'inferred' CHECK (basis_quality IN ('confirmed','inferred')),
  valid_from_s REAL NOT NULL DEFAULT 0,
  valid_until_s REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','interrupted','ended')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, owner_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, recipient_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, recipient_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (recipient_entity_id IS NULL OR recipient_location_id IS NULL),
  CHECK (valid_until_s IS NULL OR valid_until_s >= valid_from_s)
)`;
  }
  function turnChangesSql() {
    return `CREATE TABLE IF NOT EXISTS turn_changes (
  id TEXT NOT NULL PRIMARY KEY,
  turn_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  attempt_id TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_row_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert','update','delete')),
  before_json TEXT,
  after_json TEXT,
  basis_json TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (operation <> 'insert' OR before_json IS NULL),
  CHECK (operation <> 'delete' OR after_json IS NULL)
)`;
  }
  function mentionsSql() {
    return `CREATE TABLE IF NOT EXISTS mention_candidates (
  branch_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  normalized_name TEXT NOT NULL,
  context_key TEXT NOT NULL DEFAULT '',
  kind_hint TEXT NOT NULL DEFAULT 'unknown' CHECK (kind_hint IN ('character','location','item','faction','unknown')),
  first_turn_id TEXT NOT NULL,
  last_turn_id TEXT NOT NULL,
  distinct_turn_count INTEGER NOT NULL DEFAULT 1 CHECK (distinct_turn_count >= 1),
  recent_turn_ids_json TEXT NOT NULL DEFAULT '[]',
  context_summary TEXT NOT NULL DEFAULT '',
  lorebook_source_keys_json TEXT NOT NULL DEFAULT '[]',
  importance_hint TEXT NOT NULL DEFAULT 'none' CHECK (importance_hint IN ('none','review','core')),
  promoted_entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'watching' CHECK (status IN ('watching','promoted','dismissed')),
  PRIMARY KEY (branch_id, id),
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (first_turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (last_turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, promoted_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
)`;
  }
  function outboxSql() {
    return `CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT NOT NULL PRIMARY KEY,
  branch_id TEXT NOT NULL,
  requested_by_turn_id TEXT,
  target TEXT NOT NULL DEFAULT 'managed_lorebook' CHECK (target IN ('managed_lorebook')),
  projection_scope TEXT NOT NULL DEFAULT 'pov' CHECK (projection_scope IN ('pov','scene_portrayal')),
  target_revision INTEGER NOT NULL CHECK (target_revision >= 0),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_wall_ms INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_wall_ms INTEGER NOT NULL,
  completed_wall_ms INTEGER,
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (requested_by_turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
)`;
  }
  function turnsBranchKeySql() {
    return "CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_branch_id ON turns(branch_id, id)";
  }
  var ATLAS_INDEXES = [
    { name: "idx_locations_parent", table: "locations", sql: "CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(branch_id, parent_location_id)" },
    { name: "idx_locations_map", table: "locations", sql: "CREATE INDEX IF NOT EXISTS idx_locations_map ON locations(branch_id, map_id)" },
    { name: "idx_locations_anchor", table: "locations", sql: "CREATE INDEX IF NOT EXISTS idx_locations_anchor ON locations(branch_id, anchor_location_id)" },
    { name: "idx_characters_location", table: "characters", sql: "CREATE INDEX IF NOT EXISTS idx_characters_location ON characters(branch_id, location_id, status)" },
    { name: "idx_characters_map", table: "characters", sql: "CREATE INDEX IF NOT EXISTS idx_characters_map ON characters(branch_id, map_id)" },
    { name: "idx_items_holder", table: "items", sql: "CREATE INDEX IF NOT EXISTS idx_items_holder ON items(branch_id, holder_character_id)" },
    { name: "idx_items_container", table: "items", sql: "CREATE INDEX IF NOT EXISTS idx_items_container ON items(branch_id, container_item_id)" },
    { name: "idx_items_location", table: "items", sql: "CREATE INDEX IF NOT EXISTS idx_items_location ON items(branch_id, location_id)" },
    { name: "idx_relations_subject", table: "relations", sql: "CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(branch_id, subject_entity_id, status)" },
    { name: "idx_relations_object", table: "relations", sql: "CREATE INDEX IF NOT EXISTS idx_relations_object ON relations(branch_id, object_entity_id, kind, status)" },
    { name: "idx_relations_unique_key", table: "relations", sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique_key ON relations(branch_id, subject_entity_id, object_entity_id, kind, label)" },
    { name: "idx_maps_container", table: "maps", sql: "CREATE INDEX IF NOT EXISTS idx_maps_container ON maps(branch_id, container_location_id, status)" },
    {
      name: "idx_maps_container_unique",
      table: "maps",
      sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_maps_container_unique ON maps(branch_id, container_location_id) WHERE container_location_id IS NOT NULL AND status = 'active'"
    },
    { name: "idx_routes_from", table: "routes", sql: "CREATE INDEX IF NOT EXISTS idx_routes_from ON routes(branch_id, from_location_id, status)" },
    { name: "idx_routes_to", table: "routes", sql: "CREATE INDEX IF NOT EXISTS idx_routes_to ON routes(branch_id, to_location_id, status)" },
    { name: "idx_actions_due", table: "actions", sql: "CREATE INDEX IF NOT EXISTS idx_actions_due ON actions(branch_id, status, next_check_s)" },
    { name: "idx_actions_actor", table: "actions", sql: "CREATE INDEX IF NOT EXISTS idx_actions_actor ON actions(branch_id, actor_entity_id, status)" },
    { name: "idx_actions_event", table: "actions", sql: "CREATE INDEX IF NOT EXISTS idx_actions_event ON actions(branch_id, target_event_id)" },
    { name: "idx_journeys_advance", table: "journeys", sql: "CREATE INDEX IF NOT EXISTS idx_journeys_advance ON journeys(branch_id, status, last_advanced_at_s)" },
    {
      name: "idx_journeys_open_mover",
      table: "journeys",
      sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_journeys_open_mover ON journeys(branch_id, mover_entity_id) WHERE status IN ('moving','paused','blocked')"
    },
    { name: "idx_journeys_action_unique", table: "journeys", sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_journeys_action_unique ON journeys(branch_id, action_id)" },
    { name: "idx_events_place", table: "events", sql: "CREATE INDEX IF NOT EXISTS idx_events_place ON events(branch_id, location_id, occurred_at_s)" },
    { name: "idx_events_schedule", table: "events", sql: "CREATE INDEX IF NOT EXISTS idx_events_schedule ON events(branch_id, status, scheduled_start_s)" },
    { name: "idx_events_subject", table: "events", sql: "CREATE INDEX IF NOT EXISTS idx_events_subject ON events(branch_id, subject_entity_id)" },
    { name: "idx_information_subject", table: "information", sql: "CREATE INDEX IF NOT EXISTS idx_information_subject ON information(branch_id, subject_entity_id, status)" },
    { name: "idx_information_event", table: "information", sql: "CREATE INDEX IF NOT EXISTS idx_information_event ON information(branch_id, source_event_id)" },
    { name: "idx_information_topic", table: "information", sql: "CREATE INDEX IF NOT EXISTS idx_information_topic ON information(branch_id, topic_key, content_hash)" },
    {
      name: "idx_rumor_fronts_unique",
      table: "rumor_fronts",
      sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_rumor_fronts_unique ON rumor_fronts(branch_id, information_id, location_id)"
    },
    { name: "idx_rumor_fronts_spread", table: "rumor_fronts", sql: "CREATE INDEX IF NOT EXISTS idx_rumor_fronts_spread ON rumor_fronts(branch_id, status, next_spread_check_s)" },
    {
      name: "idx_knowledge_character",
      table: "knowledge",
      sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_character ON knowledge(branch_id, knower_character_id, information_id) WHERE knower_character_id IS NOT NULL"
    },
    {
      name: "idx_knowledge_faction",
      table: "knowledge",
      sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_faction ON knowledge(branch_id, knower_faction_id, information_id) WHERE knower_faction_id IS NOT NULL"
    },
    {
      name: "idx_knowledge_pov",
      table: "knowledge",
      sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_pov ON knowledge(branch_id, information_id) WHERE is_pov = 1"
    },
    { name: "idx_knowledge_information", table: "knowledge", sql: "CREATE INDEX IF NOT EXISTS idx_knowledge_information ON knowledge(branch_id, information_id)" },
    { name: "idx_channels_owner", table: "channels", sql: "CREATE INDEX IF NOT EXISTS idx_channels_owner ON channels(branch_id, owner_entity_id, status)" },
    { name: "idx_channels_source_entity", table: "channels", sql: "CREATE INDEX IF NOT EXISTS idx_channels_source_entity ON channels(branch_id, source_entity_id, status)" },
    { name: "idx_channels_source_location", table: "channels", sql: "CREATE INDEX IF NOT EXISTS idx_channels_source_location ON channels(branch_id, source_location_id, status)" },
    { name: "idx_turns_host", table: "turns", sql: "CREATE INDEX IF NOT EXISTS idx_turns_host ON turns(branch_id, host_message_uid, host_variant_key, input_hash)" },
    { name: "idx_turns_parent", table: "turns", sql: "CREATE INDEX IF NOT EXISTS idx_turns_parent ON turns(parent_turn_id)" },
    { name: "idx_turn_changes_sequence", table: "turn_changes", sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_changes_sequence ON turn_changes(turn_id, sequence)" },
    {
      name: "idx_turn_changes_group_row",
      table: "turn_changes",
      sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_changes_group_row ON turn_changes(turn_id, group_id, target_table, target_row_id)"
    },
    { name: "idx_turn_changes_target", table: "turn_changes", sql: "CREATE INDEX IF NOT EXISTS idx_turn_changes_target ON turn_changes(target_table, target_row_id)" },
    { name: "idx_mentions_name", table: "mention_candidates", sql: "CREATE INDEX IF NOT EXISTS idx_mentions_name ON mention_candidates(branch_id, normalized_name)" },
    { name: "idx_mentions_status", table: "mention_candidates", sql: "CREATE INDEX IF NOT EXISTS idx_mentions_status ON mention_candidates(branch_id, status, last_turn_id)" },
    {
      name: "idx_outbox_idempotency",
      table: "sync_outbox",
      sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idempotency ON sync_outbox(idempotency_key)"
    },
    { name: "idx_outbox_retry", table: "sync_outbox", sql: "CREATE INDEX IF NOT EXISTS idx_outbox_retry ON sync_outbox(status, next_retry_wall_ms)" }
  ];
  function schemaStatements() {
    return [
      entityKeysSql(),
      branchesSql(),
      turnsSql(),
      mapsSql(),
      locationsSql(),
      charactersSql(),
      itemsSql(),
      factionsSql(),
      relationsSql(),
      routesSql(),
      actionsSql(),
      journeysSql(),
      eventsSql(),
      informationSql(),
      rumorFrontsSql(),
      knowledgeSql(),
      channelsSql(),
      turnChangesSql(),
      mentionsSql(),
      outboxSql(),
      entityKindTrigger("locations", "location"),
      entityKindTriggerUpdate("locations", "location"),
      entityKindTrigger("characters", "character"),
      entityKindTriggerUpdate("characters", "character"),
      entityKindTrigger("items", "item"),
      entityKindTriggerUpdate("items", "item"),
      entityKindTrigger("factions", "faction"),
      entityKindTriggerUpdate("factions", "faction"),
      turnsBranchKeySql(),
      ...ATLAS_INDEXES.map((i) => i.sql)
    ];
  }
  var USER_TABLE_COUNT = Object.keys(ATLAS_TABLE_COLUMNS).length;
  function installSchemaSafe(db) {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    const names = new Set((tables[0]?.values ?? []).map((row2) => String(row2[0])));
    const existing = names.size;
    if (existing > 0 && names.size !== USER_TABLE_COUNT) {
      const expected = new Set(Object.keys(ATLAS_TABLE_COLUMNS));
      const unexpected = [...names].filter((n) => !expected.has(n));
      const missing = [...expected].filter((n) => !names.has(n));
      throw new Error(
        `DB_SCHEMA_INVALID: 用户表不是预期的 ${USER_TABLE_COUNT} 张（多 ${unexpected.length}，少 ${missing.length}）：多 ${unexpected.join(",")}；少 ${missing.join(",")}`
      );
    }
    for (const sql of schemaStatements()) db.run(sql);
    db.run(`PRAGMA user_version = ${ATLAS_SCHEMA_VERSION}`);
  }

  // src/atlas-db-runtime.ts
  var modulePromise = null;
  var injectedModule = null;
  function resetSqlModuleForTests() {
    modulePromise = null;
    injectedModule = null;
  }
  var AtlasDbError = class extends Error {
    code;
    detail;
    constructor(code, message, detail = {}) {
      super(message);
      this.name = "AtlasDbError";
      this.code = code;
      this.detail = detail;
    }
  };
  async function loadSqlModule(locateFile) {
    if (injectedModule) return injectedModule;
    if (!modulePromise) {
      modulePromise = (async () => {
        try {
          const config = locateFile ? { locateFile } : {};
          return await (0, import_sql.default)(config);
        } catch (err) {
          throw new AtlasDbError("DB_WASM_LOAD_FAILED", `sql.js 加载失败：${err.message}`, {
            locateFile: locateFile ? String(locateFile("sql-wasm.wasm")) : null
          });
        }
      })();
      modulePromise.catch(() => {
        modulePromise = null;
      });
    }
    return modulePromise;
  }
  function readPragmaNumber(db, pragma) {
    const results = db.exec(`PRAGMA ${pragma}`);
    const value = results?.[0]?.values?.[0]?.[0];
    return typeof value === "number" ? value : Number(value ?? 0);
  }
  function enableForeignKeys(db) {
    db.run("PRAGMA foreign_keys = ON");
    const enabled = readPragmaNumber(db, "foreign_keys");
    if (enabled !== 1) {
      throw new AtlasDbError("DB_FOREIGN_KEYS_OFF", "无法启用 SQLite 外键（foreign_keys 读回不是 1）", { enabled });
    }
  }
  async function openDatabase(bytes, options = {}) {
    const mod = options.sqlModule ?? await loadSqlModule();
    let db;
    if (bytes && bytes.length > 0) {
      try {
        db = new mod.Database(bytes);
      } catch (err) {
        throw new AtlasDbError("DB_IMPORT_FAILED", `导入存档失败：${err.message}`, { byteLength: bytes.length });
      }
    } else {
      db = new mod.Database();
    }
    enableForeignKeys(db);
    if (bytes && bytes.length > 0) {
      const userVersion = readPragmaNumber(db, "user_version");
      if (userVersion > ATLAS_SCHEMA_VERSION) {
        throw new AtlasDbError(
          "DB_SCHEMA_UNSUPPORTED",
          `存档 schema_version=${userVersion} 高于本实现支持的 ${ATLAS_SCHEMA_VERSION}；拒绝写库。`,
          { userVersion, supported: ATLAS_SCHEMA_VERSION }
        );
      }
    }
    return db;
  }
  function normalizeParams(params) {
    return params.map((p) => {
      if (p === void 0 || p === null) return null;
      if (typeof p === "string" || typeof p === "number") return p;
      if (p instanceof Uint8Array) return p;
      if (typeof p === "boolean") return p ? 1 : 0;
      throw new AtlasDbError("CODEC_TYPE_INVALID", `绑定参数类型不受支持：${typeof p}`, {});
    });
  }
  function bindParams(stmt, params) {
    if (params.length === 0) return;
    stmt.bind(normalizeParams(params));
  }
  function runBound(db, sql, params = []) {
    let stmt = null;
    try {
      stmt = db.prepare(sql);
      bindParams(stmt, params);
      while (stmt.step()) {
      }
    } catch (err) {
      throw new AtlasDbError("SQL_CONSTRAINT", `SQL 执行失败：${err.message}`, {
        sqlTemplate: firstLine(sql),
        paramCount: params.length
      });
    } finally {
      stmt?.free();
    }
  }
  function queryBound(db, sql, params = []) {
    let stmt = null;
    const rows2 = [];
    try {
      stmt = db.prepare(sql);
      bindParams(stmt, params);
      while (stmt.step()) {
        rows2.push(stmt.getAsObject());
      }
    } catch (err) {
      throw new AtlasDbError("SQL_QUERY_FAILED", `SQL 查询失败：${err.message}`, {
        sqlTemplate: firstLine(sql),
        paramCount: params.length
      });
    } finally {
      stmt?.free();
    }
    return rows2;
  }
  function foreignKeyCheck(db, table) {
    const sql = table ? `PRAGMA foreign_key_check(${table})` : "PRAGMA foreign_key_check";
    const rows2 = queryBound(db, sql);
    return rows2.map((r) => ({
      table: String(r.table ?? ""),
      rowid: r.rowid === null || r.rowid === void 0 ? null : Number(r.rowid),
      parent: String(r.parent ?? ""),
      fkid: Number(r.fkid ?? 0)
    }));
  }
  function userTableNames(db) {
    const rows2 = queryBound(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    return rows2.map((r) => String(r.name));
  }
  function beginTransaction(db) {
    db.run("BEGIN");
  }
  function commitTransaction(db) {
    db.run("COMMIT");
  }
  function rollbackTransaction(db) {
    try {
      db.run("ROLLBACK");
    } catch {
    }
  }
  function savepoint(db, name) {
    assertSafeIdentifier(name);
    db.run(`SAVEPOINT ${name}`);
  }
  function releaseSavepoint(db, name) {
    assertSafeIdentifier(name);
    db.run(`RELEASE SAVEPOINT ${name}`);
  }
  function rollbackToSavepoint(db, name) {
    assertSafeIdentifier(name);
    db.run(`ROLLBACK TO SAVEPOINT ${name}`);
  }
  function assertSafeIdentifier(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new AtlasDbError("SQL_UNSAFE_IDENTIFIER", `非法 SQL 标识符：${name}`, { name });
    }
  }
  function firstLine(sql) {
    return sql.split("\n")[0].trim().slice(0, 120);
  }

  // src/atlas-db-codec.ts
  var BOOLEAN_COLUMNS = /* @__PURE__ */ new Set(["scale_locked", "bidirectional", "is_pov"]);
  function isJsonColumn(name) {
    return name.endsWith("_json");
  }
  function isBooleanColumn(name) {
    return BOOLEAN_COLUMNS.has(name);
  }
  function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function normalizeValue(table, column, value) {
    const path = `${table}.${column}`;
    if (value === void 0 || value === null) return { ok: true, value: null };
    if (typeof value === "boolean") {
      if (!isBooleanColumn(column)) {
        return { ok: false, issue: { code: "CODEC_TYPE_INVALID", path, message: `列 ${column} 不是布尔列，不接受 boolean` } };
      }
      return { ok: true, value: value ? 1 : 0 };
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return { ok: false, issue: { code: "CODEC_NUMBER_NOT_FINITE", path, message: `列 ${column} 不接受 NaN/Infinity` } };
      }
      return { ok: true, value };
    }
    if (typeof value === "string") return { ok: true, value };
    if (value instanceof Uint8Array) return { ok: true, value };
    if (isPlainObject(value) || Array.isArray(value)) {
      if (!isJsonColumn(column)) {
        return { ok: false, issue: { code: "CODEC_TYPE_INVALID", path, message: `列 ${column} 不是 JSON 列，不接受对象/数组` } };
      }
      try {
        return { ok: true, value: JSON.stringify(value) };
      } catch (err) {
        return { ok: false, issue: { code: "CODEC_JSON_UNSERIALIZABLE", path, message: `列 ${column} 无法序列化：${err.message}` } };
      }
    }
    return { ok: false, issue: { code: "CODEC_TYPE_INVALID", path, message: `列 ${column} 的值类型不受支持：${typeof value}` } };
  }
  function encodeRow(table, row2, options = {}) {
    if (!isKnownTable(table)) {
      return { ok: false, issues: [{ code: "CODEC_UNKNOWN_TABLE", path: String(table), message: `未知表名：${String(table)}` }] };
    }
    const spec = ATLAS_TABLE_COLUMNS[table];
    const issues = [];
    const values = [];
    for (const column of spec) {
      const present = Object.prototype.hasOwnProperty.call(row2, column.name);
      const value = present ? row2[column.name] : null;
      if (!column.nullable && (value === null || value === void 0)) {
        issues.push({ code: "CODEC_REQUIRED_NULL", path: `${table}.${column.name}`, message: `列 ${column.name} 不允许 NULL` });
        values.push(null);
        continue;
      }
      const normalized = normalizeValue(table, column.name, value);
      if (!normalized.ok) {
        issues.push(normalized.issue);
        values.push(null);
        continue;
      }
      values.push(normalized.value);
    }
    if (options.requireAll) {
      for (const key of Object.keys(row2)) {
        if (!spec.some((c) => c.name === key)) {
          issues.push({ code: "CODEC_UNKNOWN_COLUMN", path: `${table}.${key}`, message: `表 ${table} 没有列 ${key}` });
        }
      }
    }
    if (issues.length) return { ok: false, issues };
    return { ok: true, columns: tableColumnNames(table), values, row: row2 };
  }
  function buildInsertSql(table, columns) {
    const placeholders = columns.map(() => "?").join(", ");
    return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
  }
  function buildUpdateSql(table, columns) {
    const assignments = columns.map((c) => `${c} = ?`).join(", ");
    if (table === "branches" || table === "turns" || table === "turn_changes" || table === "sync_outbox") {
      return `UPDATE ${table} SET ${assignments} WHERE id = ?`;
    }
    return `UPDATE ${table} SET ${assignments} WHERE branch_id = ? AND id = ?`;
  }
  function buildDeleteSql(table) {
    if (table === "branches" || table === "turns" || table === "turn_changes" || table === "sync_outbox") {
      return `DELETE FROM ${table} WHERE id = ?`;
    }
    return `DELETE FROM ${table} WHERE branch_id = ? AND id = ?`;
  }
  function buildInsertOrIgnoreSql(table, columns) {
    const placeholders = columns.map(() => "?").join(", ");
    return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
  }
  function encodePartialRow(table, row2) {
    if (!isKnownTable(table)) {
      return { ok: false, issues: [{ code: "CODEC_UNKNOWN_TABLE", path: String(table), message: `未知表名：${String(table)}` }] };
    }
    const allowed = new Set(tableColumnNames(table));
    const issues = [];
    const columns = [];
    const values = [];
    for (const [key, value] of Object.entries(row2)) {
      if (!allowed.has(key)) {
        issues.push({ code: "CODEC_UNKNOWN_COLUMN", path: `${table}.${key}`, message: `表 ${table} 没有列 ${key}` });
        continue;
      }
      const normalized = normalizeValue(table, key, value);
      if (!normalized.ok) {
        issues.push(normalized.issue);
        continue;
      }
      columns.push(key);
      values.push(normalized.value);
    }
    if (issues.length) return { ok: false, issues };
    return { ok: true, columns, values, row: row2 };
  }
  function decodeRow(table, row2, options = {}) {
    if (!isKnownTable(table)) {
      return { ok: false, issues: [{ code: "CODEC_UNKNOWN_TABLE", path: String(table), message: `未知表名：${String(table)}` }] };
    }
    const spec = ATLAS_TABLE_COLUMNS[table];
    const issues = [];
    const out = {};
    for (const column of spec) {
      const raw = Object.prototype.hasOwnProperty.call(row2, column.name) ? row2[column.name] : null;
      if (raw === null || raw === void 0) {
        out[column.name] = null;
        continue;
      }
      if (isBooleanColumn(column.name)) {
        if (raw === 1 || raw === 0) {
          out[column.name] = raw === 1;
        } else if (typeof raw === "boolean") {
          out[column.name] = raw;
        } else {
          issues.push({ code: "CODEC_BOOLEAN_INVALID", path: `${table}.${column.name}`, message: `布尔列 ${column.name} 的值不是 0/1：${String(raw)}` });
        }
        continue;
      }
      if (isJsonColumn(column.name)) {
        if (typeof raw !== "string") {
          issues.push({ code: "CODEC_JSON_TYPE", path: `${table}.${column.name}`, message: `JSON 列 ${column.name} 的 SQL 值必须是 TEXT` });
          continue;
        }
        try {
          out[column.name] = JSON.parse(raw);
        } catch (err) {
          issues.push({
            code: "CODEC_JSON_INVALID",
            path: `${table}.${column.name}`,
            message: `JSON 列 ${column.name} 损坏：${err.message}`
          });
        }
        continue;
      }
      if (typeof raw === "number" && !Number.isFinite(raw)) {
        issues.push({ code: "CODEC_NUMBER_NOT_FINITE", path: `${table}.${column.name}`, message: `列 ${column.name} 读到 NaN/Infinity` });
        continue;
      }
      out[column.name] = raw;
    }
    if (!options.allowExtra) {
      for (const key of Object.keys(row2)) {
        if (!spec.some((c) => c.name === key)) {
          issues.push({ code: "CODEC_UNKNOWN_COLUMN", path: `${table}.${key}`, message: `表 ${table} 没有列 ${key}` });
        }
      }
    }
    if (issues.length) return { ok: false, issues };
    return { ok: true, row: out };
  }

  // src/atlas-db-contract.ts
  var BUSINESS_TABLES = [
    "maps",
    "locations",
    "characters",
    "items",
    "factions",
    "relations",
    "routes",
    "actions",
    "journeys",
    "events",
    "information",
    "rumor_fronts",
    "knowledge",
    "channels"
  ];
  var INTERNAL_TABLES = [
    "entity_keys",
    "branches",
    "turns",
    "turn_changes",
    "mention_candidates",
    "sync_outbox"
  ];
  var JOURNALED_TABLES = [...BUSINESS_TABLES, "entity_keys", "mention_candidates", "branches"];
  var ATLAS_USER_TABLES = [...BUSINESS_TABLES, ...INTERNAL_TABLES];

  // src/atlas-db-journal.ts
  function isJournaledTable(table) {
    return JOURNALED_TABLES.includes(table);
  }
  function isKnownUserTable(table) {
    return ATLAS_USER_TABLES.includes(table);
  }
  function serializeNullable(value) {
    if (value === null || value === void 0) return null;
    return JSON.stringify(value);
  }
  function mergeGroupMutations(mutations) {
    const byKey = /* @__PURE__ */ new Map();
    const order = [];
    for (const m of mutations) {
      const key = `${m.table}\0${m.rowId}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          table: m.table,
          rowId: m.rowId,
          before: m.before === null ? null : { ...m.before },
          after: m.after === null ? null : { ...m.after },
          sourceOpIds: [...m.sourceOpIds],
          basis: { ...m.basis }
        });
        order.push(key);
        continue;
      }
      if (existing.before === null && m.before !== null) existing.before = { ...m.before };
      existing.after = m.after === null ? null : { ...m.after };
      for (const opId of m.sourceOpIds) {
        if (!existing.sourceOpIds.includes(opId)) existing.sourceOpIds.push(opId);
      }
      existing.basis = { ...existing.basis, ...m.basis };
    }
    return order.map((k) => byKey.get(k));
  }
  function mutationOperationKind(m) {
    if (m.before === null && m.after !== null) return "insert";
    if (m.before !== null && m.after === null) return "delete";
    return "update";
  }
  function recordGroupChanges(db, group, ctx) {
    const merged = mergeGroupMutations(group.mutations);
    let sequence = ctx.startSequence;
    let written = 0;
    const issues = [];
    for (let i = 0; i < merged.length; i += 1) {
      const m = merged[i];
      if (!isKnownUserTable(m.table)) {
        issues.push(`JOURNAL_TABLE_NOT_ALLOWED: ${m.table}`);
        continue;
      }
      if (!isJournaledTable(m.table)) {
        issues.push(`JOURNAL_TABLE_NOT_JOURNALED: ${m.table}`);
        continue;
      }
      assertSafeIdentifier(m.table);
      const operation = mutationOperationKind(m);
      const operationId = m.sourceOpIds.length > 0 ? m.sourceOpIds.join("+") : `${group.id}:${i}`;
      const id = ctx.makeLogId ? ctx.makeLogId(group.id, i, m.table, m.rowId) : `chg_${ctx.turnId}_${sequence}_${i}`;
      const entry = {
        id,
        turnId: ctx.turnId,
        sequence,
        attemptId: ctx.attemptId,
        groupId: group.id,
        operationId,
        targetTable: m.table,
        targetRowId: m.rowId,
        operation,
        beforeJson: serializeNullable(m.before),
        afterJson: serializeNullable(m.after),
        basisJson: JSON.stringify(m.basis ?? {}),
        summary: summarizeMutation(m, operation)
      };
      const bind = [
        entry.id,
        entry.turnId,
        entry.sequence,
        entry.attemptId,
        entry.groupId,
        entry.operationId,
        entry.targetTable,
        entry.targetRowId,
        entry.operation,
        entry.beforeJson,
        entry.afterJson,
        entry.basisJson,
        entry.summary
      ];
      try {
        runBound(
          db,
          `INSERT INTO turn_changes (id, turn_id, sequence, attempt_id, group_id, operation_id, target_table, target_row_id, operation, before_json, after_json, basis_json, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          bind
        );
      } catch (err) {
        issues.push(`JOURNAL_INSERT_FAILED: ${err.message}`);
        continue;
      }
      sequence += 1;
      written += 1;
    }
    return { written, nextSequence: sequence, issues };
  }
  function summarizeMutation(m, operation) {
    const name = m.after ?? m.before ?? {};
    const label = typeof name.name === "string" ? name.name : typeof name.title === "string" ? name.title : m.rowId;
    const verb = operation === "insert" ? "新增" : operation === "delete" ? "删除" : "修改";
    if (operation === "update" && m.before && m.after) {
      const changed = Object.keys(m.after).filter((k) => JSON.stringify(m.before[k]) !== JSON.stringify(m.after[k]));
      const fields = changed.slice(0, 6).join("、");
      return `${verb}${m.table}「${label}」：${fields}${changed.length > 6 ? " 等" : ""}`;
    }
    return `${verb}${m.table}「${label}」`;
  }
  function operationAlreadyApplied(db, turnId, operationId, table, rowId) {
    const rows2 = db.exec(
      `SELECT COUNT(*) AS n FROM turn_changes WHERE turn_id = ? AND operation_id = ? AND target_table = ? AND target_row_id = ?`,
      [turnId, operationId, table, rowId]
    );
    const n = rows2?.[0]?.values?.[0]?.[0];
    return Number(n ?? 0) > 0;
  }
  function readTurnChanges(db, turnId) {
    const rows2 = db.exec(
      `SELECT id, turn_id, sequence, attempt_id, group_id, operation_id, target_table, target_row_id, operation, before_json, after_json, basis_json, summary
     FROM turn_changes WHERE turn_id = ? ORDER BY sequence ASC`,
      [turnId]
    );
    if (!rows2 || rows2.length === 0) return [];
    const cols2 = rows2[0].columns;
    return rows2[0].values.map((v) => {
      const rec = {};
      cols2.forEach((c, i) => {
        rec[c] = v[i];
      });
      return {
        id: String(rec.id),
        turnId: String(rec.turn_id),
        sequence: Number(rec.sequence),
        attemptId: String(rec.attempt_id ?? ""),
        groupId: String(rec.group_id ?? ""),
        operationId: String(rec.operation_id ?? ""),
        targetTable: String(rec.target_table),
        targetRowId: String(rec.target_row_id),
        operation: rec.operation,
        beforeJson: rec.before_json === null ? null : String(rec.before_json),
        afterJson: rec.after_json === null ? null : String(rec.after_json),
        basisJson: String(rec.basis_json ?? "{}"),
        summary: String(rec.summary ?? "")
      };
    });
  }

  // src/atlas-runtime-limits.ts
  var ATLAS_RUNTIME_LIMITS = {
    responseUtf8Bytes: 256 * 1024,
    operationsPerResponse: 64,
    operationUtf8Bytes: 8 * 1024,
    responseJsonDepth: 16,
    conditionDepth: 4,
    repairAttemptsPerBatch: 1,
    actorsPerDecisionBatch: 24,
    foregroundModelBatchesPerTurn: 4,
    pendingCandidateTtlMs: 10 * 60 * 1e3,
    normalResponseTokens: 4096,
    repairResponseTokens: 2048,
    modelTimeoutMs: 12e4,
    mentionCandidates: 256,
    locationDepth: 4,
    containerDepth: 4,
    actionPlanDepth: 2,
    detailedAttemptsPerTurn: 20,
    diagnosticPageSize: 100
  };
  var ATLAS_FIELD_LIMITS = {
    aliasLimit: 8,
    capabilityLimit: 16,
    mobilityProfileLimit: 8,
    itemPropertyLimit: 16,
    participantsLimit: 16,
    geometryVertexLimit: 256,
    mentionRecentLimit: 8,
    journeySegmentLimit: 32,
    actionDependsLimit: 8,
    actionPayloadRefLimit: 8
  };
  var ACTION_PAYLOAD_REF_LIMIT = 8;
  var ACTION_DEPENDS_LIMIT = 8;
  var CAPABILITY_LIMIT = 16;
  var MOBILITY_PROFILE_LIMIT = 8;
  var ALIAS_LIMIT = 8;
  var PARTICIPANTS_LIMIT = 16;
  var GEOMETRY_VERTEX_LIMIT = 256;
  var MENTION_RECENT_LIMIT = 8;
  var MENTION_LOREBOOK_LIMIT = 8;
  var MENTION_CONTEXT_SUMMARY_CHARS = 200;
  var WHY_MAX_CHARS = 200;
  var ITEM_PROPERTY_LIMIT = 16;

  // src/atlas-db-invariants.ts
  var LOCATION_DEPTH = ATLAS_RUNTIME_LIMITS.locationDepth;
  var CONTAINER_DEPTH = ATLAS_RUNTIME_LIMITS.containerDepth;
  var ACTION_PLAN_DEPTH = ATLAS_RUNTIME_LIMITS.actionPlanDepth;
  var CAPABILITY_LIMIT2 = ATLAS_FIELD_LIMITS.capabilityLimit;
  var MOBILITY_PROFILE_LIMIT2 = ATLAS_FIELD_LIMITS.mobilityProfileLimit;
  var ALIAS_LIMIT2 = ATLAS_FIELD_LIMITS.aliasLimit;
  var PARTICIPANTS_LIMIT2 = ATLAS_FIELD_LIMITS.participantsLimit;
  var GEOMETRY_VERTEX_LIMIT2 = ATLAS_FIELD_LIMITS.geometryVertexLimit;
  var ITEM_PROPERTY_LIMIT2 = ATLAS_FIELD_LIMITS.itemPropertyLimit;
  var MENTION_RECENT_LIMIT2 = ATLAS_FIELD_LIMITS.mentionRecentLimit;
  function violation(code, table, rowId, field, message, beforeAfter) {
    return { code, table, rowId, field, message, beforeAfter };
  }
  function toIssue(v) {
    return {
      code: v.code,
      path: `${v.table}.${v.field}`,
      message: `${v.message}（表 ${v.table} 行 ${v.rowId ?? "—"} 字段 ${v.field}）`,
      severity: "error",
      retryable: false
    };
  }
  function rowsOf(db, table, branchId) {
    const hasBranch = tableColumnNames(table).includes("branch_id");
    const sql = hasBranch ? `SELECT * FROM ${table} WHERE branch_id = ?` : `SELECT * FROM ${table}`;
    const raw = queryBound(db, sql, hasBranch ? [branchId] : []);
    return raw.map((r) => {
      const decoded = decodeRow(table, r, { allowExtra: true });
      return decoded.ok ? decoded.row : r;
    });
  }
  function rowIdOf(_table, row2) {
    return String(row2.id ?? "");
  }
  function finiteOrNull(value) {
    if (value === null || value === void 0) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) return Number.NaN;
    return value;
  }
  function isJsonColumn2(name) {
    return name.endsWith("_json");
  }
  function checkCoordinates(table, row2, out) {
    const hasX = row2.grid_x !== void 0 && row2.grid_x !== null;
    const hasY = row2.grid_y !== void 0 && row2.grid_y !== null;
    const id = rowIdOf(table, row2);
    if (hasX !== hasY) {
      out.push(violation("INVARIANT_COORD_PAIR", table, id, "grid_x/grid_y", "坐标 x/y 必须同时有值或同时为空"));
    }
    const x = finiteOrNull(row2.grid_x);
    const y = finiteOrNull(row2.grid_y);
    if (x !== null && Number.isNaN(x)) out.push(violation("INVARIANT_COORD_NOT_FINITE", table, id, "grid_x", "坐标必须是有限数字（未知不是 NaN/Infinity）"));
    if (y !== null && Number.isNaN(y)) out.push(violation("INVARIANT_COORD_NOT_FINITE", table, id, "grid_y", "坐标必须是有限数字（未知不是 NaN/Infinity）"));
    if ((hasX || hasY) && (row2.map_id === null || row2.map_id === void 0)) {
      out.push(violation("INVARIANT_COORD_WITHOUT_MAP", table, id, "map_id", "有坐标必须有 map_id"));
    }
    if (table === "characters" && row2.coord_precision === "layout") {
      out.push(violation("INVARIANT_CHARACTER_LAYOUT_COORD", table, id, "coord_precision", "人物不把 layout 坐标当实际位置"));
    }
    if (table === "locations" && row2.map_id && row2.map_id === id) {
      out.push(violation("INVARIANT_LOCATION_MAP_SELF", table, id, "map_id", "地点所在坐标系不能是它自己的内部地图"));
    }
  }
  function findCycle(edges, selfLoopCode, table, field, out) {
    const state = /* @__PURE__ */ new Map();
    const stack = [];
    const visit = (node) => {
      const st = state.get(node) ?? 0;
      if (st === 1) {
        const start = stack.indexOf(node);
        const cyclePath = [...stack.slice(start >= 0 ? start : 0), node];
        out.push(violation(selfLoopCode, table, node, field, `检测到环：${cyclePath.join(" -> ")}`));
        return;
      }
      if (st === 2) return;
      state.set(node, 1);
      stack.push(node);
      const next = edges.get(node) ?? null;
      if (next && edges.has(next)) visit(next);
      else if (next === node) out.push(violation(selfLoopCode, table, node, field, "指向自身形成环"));
      stack.pop();
      state.set(node, 2);
    };
    for (const node of edges.keys()) visit(node);
  }
  function validateCandidate(db, options) {
    const branchId = options.branchId;
    const violations = [];
    const checked = [];
    const only = options.tables ? new Set(options.tables) : null;
    const onlyRows = options.rowIds;
    const shouldCheck = (table, id) => {
      if (only && !only.has(table)) return false;
      if (onlyRows && onlyRows.size > 0 && !onlyRows.has(id)) return false;
      return true;
    };
    const entityKeys = rowsOf(db, "entity_keys", branchId);
    const keyKindById = /* @__PURE__ */ new Map();
    for (const key of entityKeys) {
      const id = String(key.id ?? "");
      const kind = String(key.kind ?? "");
      if (!["location", "character", "item", "faction"].includes(kind)) {
        violations.push(violation("INVARIANT_ENTITY_KEY_KIND", "entity_keys", id, "kind", `身份类型非法：${kind}`));
        continue;
      }
      keyKindById.set(id, kind);
    }
    const detailTables = [
      ["locations", "location"],
      ["characters", "character"],
      ["items", "item"],
      ["factions", "faction"]
    ];
    const detailIdsByKind = /* @__PURE__ */ new Map();
    for (const [table, kind] of detailTables) {
      const rows2 = rowsOf(db, table, branchId);
      const ids = /* @__PURE__ */ new Set();
      for (const row2 of rows2) {
        const id = rowIdOf(table, row2);
        ids.add(id);
        const keyKind = keyKindById.get(id);
        if (!keyKind) {
          violations.push(violation("INVARIANT_ENTITY_WITHOUT_KEY", table, id, "id", "实体详情没有对应的 entity_keys 身份"));
        } else if (keyKind !== kind) {
          violations.push(violation("INVARIANT_ENTITY_KIND_MISMATCH", table, id, "id", `身份类型 ${keyKind} 与详情表 ${table} 不一致`));
        }
        if (shouldCheck(table, id)) {
          checkCoordinates(table, row2, violations);
          checked.push(`${table}:${id}`);
        }
      }
      detailIdsByKind.set(kind, ids);
    }
    for (const key of entityKeys) {
      const id = String(key.id ?? "");
      const kind = String(key.kind ?? "");
      const ids = detailIdsByKind.get(kind);
      if (ids && !ids.has(id)) {
        violations.push(violation("INVARIANT_KEY_WITHOUT_ENTITY", "entity_keys", id, "id", `身份没有对应的 ${kind} 详情`));
      }
    }
    const locations = rowsOf(db, "locations", branchId);
    const parentEdges = /* @__PURE__ */ new Map();
    const parentOf = /* @__PURE__ */ new Map();
    for (const loc of locations) {
      const id = String(loc.id);
      const parent = loc.parent_location_id === null || loc.parent_location_id === void 0 ? null : String(loc.parent_location_id);
      parentEdges.set(id, parent);
      parentOf.set(id, parent);
    }
    findCycle(parentEdges, "INVARIANT_LOCATION_PARENT_CYCLE", "locations", "parent_location_id", violations);
    for (const id of parentOf.keys()) {
      let depth = 0;
      let cursor = parentOf.get(id) ?? null;
      const seen = /* @__PURE__ */ new Set([id]);
      while (cursor) {
        if (seen.has(cursor)) break;
        seen.add(cursor);
        depth += 1;
        if (depth > LOCATION_DEPTH) {
          violations.push(violation("INVARIANT_LOCATION_DEPTH", "locations", id, "parent_location_id", `地点层级超过上限 ${LOCATION_DEPTH}`));
          break;
        }
        cursor = parentOf.get(cursor) ?? null;
      }
    }
    const items = rowsOf(db, "items", branchId);
    const containerEdges = /* @__PURE__ */ new Map();
    for (const item of items) {
      const id = String(item.id);
      const container = item.container_item_id === null || item.container_item_id === void 0 ? null : String(item.container_item_id);
      containerEdges.set(id, container);
      const sources = [item.holder_character_id, item.container_item_id, item.location_id].filter((v) => v !== null && v !== void 0);
      if (sources.length > 1) {
        violations.push(violation("INVARIANT_ITEM_MULTIPLE_PLACEMENT", "items", id, "holder_character_id/container_item_id/location_id", "一件物品只能有一个实际持有/容纳/独立放置来源"));
      }
      if (typeof item.quantity === "number" && item.quantity < 0) {
        violations.push(violation("INVARIANT_QUANTITY_NEGATIVE", "items", id, "quantity", "数量不能为负"));
      }
      if (item.quantity === 0 && item.status === "active") {
        violations.push(violation("INVARIANT_QUANTITY_ZERO_ACTIVE", "items", id, "status", "数量为 0 时必须转为 consumed，不能继续交易"));
      }
      if (shouldCheck("items", id)) checkCoordinates("items", item, violations);
    }
    findCycle(containerEdges, "INVARIANT_CONTAINER_CYCLE", "items", "container_item_id", violations);
    for (const id of containerEdges.keys()) {
      let depth = 0;
      let cursor = containerEdges.get(id) ?? null;
      const seen = /* @__PURE__ */ new Set([id]);
      while (cursor) {
        if (seen.has(cursor)) break;
        seen.add(cursor);
        depth += 1;
        if (depth > CONTAINER_DEPTH) {
          violations.push(violation("INVARIANT_CONTAINER_DEPTH", "items", id, "container_item_id", `容器链超过上限 ${CONTAINER_DEPTH}`));
          break;
        }
        cursor = containerEdges.get(cursor) ?? null;
      }
    }
    const characters = rowsOf(db, "characters", branchId);
    const deadOrDown = /* @__PURE__ */ new Set();
    for (const ch of characters) {
      const id = String(ch.id);
      if (ch.physical_status === "dead" || ch.physical_status === "incapacitated") deadOrDown.add(id);
      if (shouldCheck("characters", id)) checkCoordinates("characters", ch, violations);
      checkListLimits("characters", id, ch, violations);
    }
    const journeys = rowsOf(db, "journeys", branchId);
    const openByMover = /* @__PURE__ */ new Map();
    for (const j of journeys) {
      const mover = String(j.mover_entity_id);
      const status = String(j.status);
      if (["moving", "paused", "blocked"].includes(status)) {
        const list = openByMover.get(mover) ?? [];
        list.push(String(j.id));
        openByMover.set(mover, list);
      }
      if (["moving", "paused", "blocked"].includes(status) && deadOrDown.has(mover)) {
        violations.push(violation("INVARIANT_DEAD_MOVER_TRAVELING", "journeys", String(j.id), "mover_entity_id", "已死亡/失去行动能力者不能有未结束行程"));
      }
      if (status === "moving" && j.stop_location_id !== null && j.stop_location_id !== void 0) {
        violations.push(violation("INVARIANT_MOVING_WITH_STOP", "journeys", String(j.id), "stop_location_id", "moving 与静止落点互斥"));
      }
      const started = finiteOrNull(j.started_at_s);
      const advanced = finiteOrNull(j.last_advanced_at_s);
      if (started !== null && advanced !== null && !Number.isNaN(started) && !Number.isNaN(advanced) && advanced < started) {
        violations.push(violation("INVARIANT_JOURNEY_TIME_ORDER", "journeys", String(j.id), "last_advanced_at_s", "last_advanced_at_s 不能早于 started_at_s"));
      }
    }
    for (const list of openByMover.values()) {
      if (list.length > 1) {
        violations.push(violation("INVARIANT_MULTIPLE_OPEN_JOURNEYS", "journeys", list[0], "mover_entity_id", `同一 mover 有 ${list.length} 条未结束行程`));
      }
    }
    const actions = rowsOf(db, "actions", branchId);
    for (const a of actions) {
      if (deadOrDown.has(String(a.actor_entity_id)) && ["active", "ready"].includes(String(a.status))) {
        violations.push(violation("INVARIANT_DEAD_ACTOR_ACTION", "actions", String(a.id), "actor_entity_id", "死亡/失去行动能力者不能继续执行 active/ready 行动"));
      }
    }
    const actionById = new Map(actions.map((a) => [String(a.id), a]));
    const actionDepends = /* @__PURE__ */ new Map();
    for (const a of actions) {
      const id = String(a.id);
      const parent = a.parent_action_id === null || a.parent_action_id === void 0 ? null : String(a.parent_action_id);
      actionDepends.set(id, parent);
      if (Array.isArray(a.depends_on_json)) {
        for (const dep of a.depends_on_json) {
          if (!actionById.has(dep)) {
            violations.push(violation("INVARIANT_ACTION_DEPENDENCY_UNKNOWN", "actions", id, "depends_on_json", `依赖的行动不存在：${dep}`));
          }
          if (dep === id) {
            violations.push(violation("INVARIANT_ACTION_DEPENDENCY_CYCLE", "actions", id, "depends_on_json", "行动不能依赖自己"));
          }
        }
        if (a.depends_on_json.length > 8) {
          violations.push(violation("INVARIANT_ACTION_DEPENDENCY_COUNT", "actions", id, "depends_on_json", "depends_on_json 最多 8 项"));
        }
      }
      let depth = 0;
      let cursor = parent;
      const seen = /* @__PURE__ */ new Set([id]);
      while (cursor) {
        if (seen.has(cursor)) {
          violations.push(violation("INVARIANT_ACTION_PLAN_CYCLE", "actions", id, "parent_action_id", "计划父子链形成环"));
          break;
        }
        seen.add(cursor);
        depth += 1;
        if (depth > ACTION_PLAN_DEPTH) {
          violations.push(violation("INVARIANT_ACTION_PLAN_DEPTH", "actions", id, "parent_action_id", `计划最多 ${ACTION_PLAN_DEPTH} 层`));
          break;
        }
        const parentRow = actionById.get(cursor);
        cursor = parentRow && parentRow.parent_action_id ? String(parentRow.parent_action_id) : null;
      }
    }
    findCycle(actionDepends, "INVARIANT_ACTION_PARENT_CYCLE", "actions", "parent_action_id", violations);
    const information = rowsOf(db, "information", branchId);
    const infoEdges = /* @__PURE__ */ new Map();
    for (const info of information) {
      const id = String(info.id);
      infoEdges.set(id, info.parent_information_id === null || info.parent_information_id === void 0 ? null : String(info.parent_information_id));
      const created = finiteOrNull(info.created_at_s);
      const expires = finiteOrNull(info.expires_at_s);
      if (created !== null && expires !== null && !Number.isNaN(created) && !Number.isNaN(expires) && expires < created) {
        violations.push(violation("INVARIANT_INFORMATION_EXPIRY", "information", id, "expires_at_s", "expires_at_s 不能早于 created_at_s"));
      }
    }
    findCycle(infoEdges, "INVARIANT_INFORMATION_LINK_CYCLE", "information", "parent_information_id", violations);
    const events = rowsOf(db, "events", branchId);
    for (const ev of events) {
      const id = String(ev.id);
      const status = String(ev.status);
      if ((status === "occurred" || status === "ongoing") && (ev.occurred_at_s === null || ev.occurred_at_s === void 0)) {
        violations.push(violation("INVARIANT_EVENT_OCCURRED_NEEDS_TIME", "events", id, "occurred_at_s", "occurred/ongoing 事件必须有实际发生时刻"));
      }
      if (Array.isArray(ev.participants_json) && ev.participants_json.length > PARTICIPANTS_LIMIT2) {
        violations.push(violation("INVARIANT_EVENT_PARTICIPANTS_LIMIT", "events", id, "participants_json", `participants 最多 ${PARTICIPANTS_LIMIT2} 个`));
      }
    }
    const knowledge = rowsOf(db, "knowledge", branchId);
    const seenKnower = /* @__PURE__ */ new Map();
    for (const k of knowledge) {
      const id = String(k.id);
      const hasCharacter = k.knower_character_id !== null && k.knower_character_id !== void 0;
      const hasFaction = k.knower_faction_id !== null && k.knower_faction_id !== void 0;
      const isPov = Number(k.is_pov ?? 0) === 1;
      const count = (hasCharacter ? 1 : 0) + (hasFaction ? 1 : 0) + (isPov ? 1 : 0);
      if (count !== 1) {
        violations.push(violation("INVARIANT_KNOWLEDGE_HOLDER", "knowledge", id, "knower_character_id/knower_faction_id/is_pov", "三种持有者必须且只能选择一种"));
      }
      const informationId = String(k.information_id);
      const key = hasCharacter ? `c:${String(k.knower_character_id)}:${informationId}` : hasFaction ? `f:${String(k.knower_faction_id)}:${informationId}` : `pov:${informationId}`;
      const existing = seenKnower.get(key);
      if (existing && existing !== id) {
        violations.push(violation("INVARIANT_KNOWLEDGE_DUPLICATE", "knowledge", id, "information_id", `同一持有者对同一信息有两条当前认知（另一条 ${existing}）`));
      } else {
        seenKnower.set(key, id);
      }
    }
    const channels = rowsOf(db, "channels", branchId);
    for (const c of channels) {
      const id = String(c.id);
      if (c.recipient_entity_id && c.recipient_location_id) {
        violations.push(violation("INVARIANT_CHANNEL_RECIPIENT", "channels", id, "recipient_entity_id/recipient_location_id", "recipient 实体/地点至多一个"));
      }
      const scope = c.scope_json;
      const hasScope = Boolean(scope && (Array.isArray(scope.location_refs) && scope.location_refs.length > 0 || Array.isArray(scope.entity_refs) && scope.entity_refs.length > 0));
      if (!c.source_entity_id && !c.source_location_id && !hasScope) {
        violations.push(violation("INVARIANT_CHANNEL_SCOPE", "channels", id, "scope_json", "渠道必须至少有一项来源或有效范围；范围不能默认为整个世界"));
      }
      if (Array.isArray(scope?.location_refs)) {
        for (const ref of scope.location_refs) {
          if (!parentOf.has(ref)) violations.push(violation("INVARIANT_CHANNEL_SCOPE_REF", "channels", id, "scope_json.location_refs", `地点引用不存在：${ref}`));
        }
      }
    }
    const mentions = rowsOf(db, "mention_candidates", branchId);
    for (const m of mentions) {
      const id = String(m.id);
      if (Array.isArray(m.recent_turn_ids_json) && m.recent_turn_ids_json.length > MENTION_RECENT_LIMIT2) {
        violations.push(violation("INVARIANT_MENTION_RECENT_LIMIT", "mention_candidates", id, "recent_turn_ids_json", `最近提及最多 ${MENTION_RECENT_LIMIT2} 条`));
      }
      if (m.promoted_entity_id && !keyKindById.has(String(m.promoted_entity_id))) {
        violations.push(violation("INVARIANT_MENTION_PROMOTED_REF", "mention_candidates", id, "promoted_entity_id", `promoted_entity_id 指向不存在的身份：${String(m.promoted_entity_id)}`));
      }
      if (typeof m.distinct_turn_count === "number" && m.distinct_turn_count < 1) {
        violations.push(violation("INVARIANT_MENTION_COUNT", "mention_candidates", id, "distinct_turn_count", "distinct_turn_count 至少为 1"));
      }
    }
    validateJsonRefs(db, branchId, keyKindById, parentOf, violations);
    for (const table of ["maps", "locations", "characters", "items", "factions", "relations", "routes", "actions", "journeys", "events", "information", "rumor_fronts", "knowledge", "channels"]) {
      const rows2 = rowsOf(db, table, branchId);
      for (const row2 of rows2) {
        const id = String(row2.id);
        if (row2.row_rev !== void 0 && (typeof row2.row_rev !== "number" || row2.row_rev < 1)) {
          violations.push(violation("INVARIANT_ROW_REV", table, id, "row_rev", "row_rev 必须是正整数"));
        }
        if (!row2.created_turn_id || !row2.updated_turn_id) {
          violations.push(violation("INVARIANT_TURN_REF", table, id, "created_turn_id/updated_turn_id", "C 列的创建/更新推演记录不能为空"));
        }
        for (const [column, value] of Object.entries(row2)) {
          if (isJsonColumn2(column) && value !== null && typeof value === "object") {
            continue;
          }
        }
      }
    }
    const branches = rowsOf(db, "branches", branchId);
    for (const b of branches) {
      const id = String(b.id);
      const clock = finiteOrNull(b.clock_s);
      const min = finiteOrNull(b.clock_min_s);
      const max = finiteOrNull(b.clock_max_s);
      if (clock === null || min === null || max === null || Number.isNaN(clock) || Number.isNaN(min) || Number.isNaN(max)) {
        violations.push(violation("INVARIANT_BRANCH_CLOCK_FINITE", "branches", id, "clock_s", "时钟必须是有限数字"));
        continue;
      }
      if (clock < 0 || min < 0 || max < 0) violations.push(violation("INVARIANT_BRANCH_CLOCK_NEGATIVE", "branches", id, "clock_s", "负时间非法"));
      if (!(min <= clock && clock <= max)) {
        violations.push(violation("INVARIANT_BRANCH_CLOCK_ORDER", "branches", id, "clock_s", "clock_min ≤ clock ≤ clock_max 必须成立"));
      }
      const pov = b.pov_character_id;
      if (pov && !detailIdsByKind.get("character")?.has(String(pov))) {
        violations.push(violation("INVARIANT_BRANCH_POV", "branches", id, "pov_character_id", `pov_character_id 必须在本分支的人物中：${String(pov)}`));
      }
      const root = b.root_map_id;
      if (root) {
        const mapExists = queryBound(db, "SELECT COUNT(*) AS n FROM maps WHERE branch_id = ? AND id = ?", [branchId, String(root)]);
        if (Number(mapExists[0]?.n ?? 0) === 0) {
          violations.push(violation("INVARIANT_BRANCH_ROOT_MAP", "branches", id, "root_map_id", `root_map_id 指向不存在的地图：${String(root)}`));
        }
      }
    }
    for (const pending of options.pendingRows ?? []) {
      if (!isKnownTable(pending.table)) continue;
      if (!pending.row) continue;
      const table = pending.table;
      if (["locations", "characters", "items"].includes(table)) {
        checkCoordinates(table, pending.row, violations);
      }
      for (const column of ATLAS_TABLE_COLUMNS[table]) {
        if (!column.nullable && (pending.row[column.name] === null || pending.row[column.name] === void 0)) {
          violations.push(violation("INVARIANT_REQUIRED_NULL", table, pending.rowId, column.name, `列 ${column.name} 不允许为 NULL`));
        }
      }
      for (const [column, value] of Object.entries(pending.row)) {
        if (typeof value === "number" && !Number.isFinite(value)) {
          violations.push(violation("INVARIANT_NOT_FINITE", table, pending.rowId, column, "数值必须是有限数字（NaN/Infinity 非法）"));
        }
      }
    }
    return {
      ok: violations.length === 0,
      violations,
      issues: violations.map(toIssue),
      checked
    };
  }
  function checkListLimits(table, id, row2, out) {
    const checks = [
      ["aliases_json", ALIAS_LIMIT2],
      ["capabilities_json", CAPABILITY_LIMIT2],
      ["mobility_profiles_json", MOBILITY_PROFILE_LIMIT2],
      ["properties_json", ITEM_PROPERTY_LIMIT2]
    ];
    for (const [column, limit] of checks) {
      const value = row2[column];
      if (Array.isArray(value) && value.length > limit) {
        out.push(violation("INVARIANT_LIST_LIMIT", table, id, column, `${column} 超过上限 ${limit}`));
      }
    }
    const geometry = row2.area_geometry_json;
    if (geometry && typeof geometry === "object" && Array.isArray(geometry.coordinates)) {
      if (geometry.coordinates.length > GEOMETRY_VERTEX_LIMIT2) {
        out.push(violation("INVARIANT_GEOMETRY_LIMIT", table, id, "area_geometry_json", `几何顶点超过上限 ${GEOMETRY_VERTEX_LIMIT2}`));
      }
    }
  }
  function validateJsonRefs(db, branchId, keyKindById, locationIds, out) {
    const actions = rowsOf(db, "actions", branchId);
    const actionIds = new Set(actions.map((a) => String(a.id)));
    const informationIds = new Set(rowsOf(db, "information", branchId).map((i) => String(i.id)));
    const channelIds = new Set(rowsOf(db, "channels", branchId).map((c) => String(c.id)));
    const routeIds = new Set(rowsOf(db, "routes", branchId).map((r) => String(r.id)));
    const eventIds = new Set(rowsOf(db, "events", branchId).map((e) => String(e.id)));
    for (const a of actions) {
      const id = String(a.id);
      const payload = a.payload_json;
      if (!payload || typeof payload !== "object") continue;
      const refKeys = ["destination_ref", "information_ref", "channel_ref", "other_ref", "subject_ref"];
      for (const key of refKeys) {
        const value = payload[key];
        if (typeof value !== "string" || value === "") continue;
        const ok = key === "destination_ref" && locationIds.has(value) || key === "information_ref" && informationIds.has(value) || key === "channel_ref" && channelIds.has(value) || (key === "other_ref" || key === "subject_ref") && keyKindById.has(value);
        if (!ok) {
          out.push(violation("INVARIANT_JSON_REF_UNKNOWN", "actions", id, `payload_json.${key}`, `JSON 引用不存在：${value}`));
        }
      }
      if (Array.isArray(payload.via_refs)) {
        for (const v of payload.via_refs) {
          if (!locationIds.has(v)) {
            out.push(violation("INVARIANT_JSON_REF_UNKNOWN", "actions", id, "payload_json.via_refs", `JSON 引用不存在：${v}`));
          }
        }
      }
      const trigger = a.trigger_json;
      if (trigger && typeof trigger === "object") {
        const leaves = collectConditionLeaves(trigger, 0);
        for (const leaf of leaves) {
          const kind = Object.keys(leaf)[0] ?? "";
          const body = leaf[kind];
          if (!body) continue;
          if (kind === "at_location" && body.location_ref && !locationIds.has(String(body.location_ref))) {
            out.push(violation("INVARIANT_JSON_REF_UNKNOWN", "actions", id, "trigger_json.at_location.location_ref", `条件引用不存在：${String(body.location_ref)}`));
          }
          if (kind === "action_status" && body.action_ref && !actionIds.has(String(body.action_ref))) {
            out.push(violation("INVARIANT_JSON_REF_UNKNOWN", "actions", id, "trigger_json.action_status.action_ref", `条件引用不存在：${String(body.action_ref)}`));
          }
          if (kind === "event_status" && body.event_ref && !eventIds.has(String(body.event_ref))) {
            out.push(violation("INVARIANT_JSON_REF_UNKNOWN", "actions", id, "trigger_json.event_status.event_ref", `条件引用不存在：${String(body.event_ref)}`));
          }
        }
      }
    }
    const fronts = rowsOf(db, "rumor_fronts", branchId);
    for (const f of fronts) {
      const id = String(f.id);
      if (!informationIds.has(String(f.information_id))) {
        out.push(violation("INVARIANT_JSON_REF_UNKNOWN", "rumor_fronts", id, "information_id", `引用不存在：${String(f.information_id)}`));
      }
      if (!locationIds.has(String(f.location_id))) {
        out.push(violation("INVARIANT_JSON_REF_UNKNOWN", "rumor_fronts", id, "location_id", `引用不存在：${String(f.location_id)}`));
      }
    }
    const events = rowsOf(db, "events", branchId);
    for (const e of events) {
      const id = String(e.id);
      if (e.route_id && !routeIds.has(String(e.route_id))) {
        out.push(violation("INVARIANT_JSON_REF_UNKNOWN", "events", id, "route_id", `引用不存在：${String(e.route_id)}`));
      }
      if (Array.isArray(e.participants_json)) {
        for (const p of e.participants_json) {
          if (p && typeof p.entity_id === "string" && !keyKindById.has(p.entity_id)) {
            out.push(violation("INVARIANT_JSON_REF_UNKNOWN", "events", id, "participants_json", `参与者引用不存在：${p.entity_id}`));
          }
        }
      }
    }
  }
  function collectConditionLeaves(condition, depth) {
    if (depth > 4) return [];
    const leaves = [];
    for (const [key, value] of Object.entries(condition)) {
      if ((key === "all" || key === "any") && Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object") leaves.push(...collectConditionLeaves(child, depth + 1));
        }
      } else if (key !== "all" && key !== "any") {
        leaves.push({ [key]: value });
      }
    }
    return leaves;
  }
  function validateGroup(db, branchId, tables, rowIds, pendingRows) {
    return validateCandidate(db, { branchId, tables, rowIds: new Set(rowIds), pendingRows });
  }

  // src/atlas-db-commit.ts
  function issue(code, message, extra = {}) {
    return { code, path: "$", message, severity: "error", retryable: true, ...extra };
  }
  function applyMutation(db, m, branchId) {
    if (!isKnownTable(m.table)) throw new AtlasDbError("SQL_UNKNOWN_TABLE", `不在白名单的表：${m.table}`, { table: m.table });
    const table = m.table;
    assertSafeIdentifier(table);
    const kind = mutationOperationKind(m);
    if (kind === "insert") {
      const encoded2 = table === "entity_keys" ? encodePartialRow(table, m.after) : encodeRow(table, m.after, { requireAll: true });
      if (!encoded2.ok) {
        throw new AtlasDbError("CODEC_ENCODE_FAILED", `写入前编码失败：${encoded2.issues.map((i) => i.path).join(", ")}`, {
          issues: encoded2.issues
        });
      }
      const sql = table === "entity_keys" ? buildInsertOrIgnoreSql(table, encoded2.columns) : buildInsertSql(table, encoded2.columns);
      runBound(db, sql, encoded2.values);
      return;
    }
    if (kind === "delete") {
      const params2 = table === "branches" || table === "turns" || table === "turn_changes" || table === "sync_outbox" ? [m.rowId] : [branchId, m.rowId];
      runBound(db, buildDeleteSql(table), params2);
      return;
    }
    const encoded = encodeRow(table, m.after, { requireAll: true });
    if (!encoded.ok) {
      throw new AtlasDbError("CODEC_ENCODE_FAILED", `写入前编码失败：${encoded.issues.map((i) => i.path).join(", ")}`, {
        issues: encoded.issues
      });
    }
    const params = table === "branches" || table === "turns" || table === "turn_changes" || table === "sync_outbox" ? [...encoded.values, m.rowId] : [...encoded.values, branchId, m.rowId];
    runBound(db, buildUpdateSql(table, encoded.columns), params);
  }
  function applyGroups(db, orderedGroups, ctx) {
    const appliedKeys = ctx.appliedKeys ? new Set(ctx.appliedKeys) : /* @__PURE__ */ new Set();
    const results = [];
    const journalIssues = [];
    const validate = ctx.validate !== false;
    const journal = ctx.journal !== false;
    const blockedGroups = /* @__PURE__ */ new Set();
    let sequencesUsed = 0;
    let sequence = 1;
    const maxSeq = queryBound(db, "SELECT COALESCE(MAX(sequence), 0) AS m FROM turn_changes WHERE turn_id = ?", [ctx.turnId]);
    sequence = Number(maxSeq[0]?.m ?? 0) + 1;
    for (const group of orderedGroups) {
      const gid = group.id;
      const failedDep = group.dependsOn.find((dep) => {
        const r = results.find((x) => x.groupId === dep);
        return !r || r.status === "rejected" || r.status === "blocked";
      });
      if (failedDep || blockedGroups.has(gid)) {
        const root = failedDep ?? [...blockedGroups][0] ?? "unknown";
        results.push({
          groupId: gid,
          opIds: group.opIds,
          status: "blocked",
          issues: [issue("DEPENDENCY_FAILED", `上游组 ${root} 未成功：本组不执行`, { groupId: gid, dependencyId: root, retryable: true })],
          changedRows: 0
        });
        blockedGroups.add(gid);
        continue;
      }
      const groupKeys = group.mutations.map((m) => `${m.table}\0${m.rowId}\0${m.sourceOpIds.join("+")}`);
      const allApplied = groupKeys.length > 0 && groupKeys.every((k) => appliedKeys.has(k));
      if (allApplied) {
        results.push({ groupId: gid, opIds: group.opIds, status: "duplicate", issues: [], changedRows: 0 });
        continue;
      }
      const anyDuplicate = group.mutations.some(
        (m) => operationAlreadyApplied(db, ctx.turnId, m.sourceOpIds.join("+"), m.table, m.rowId) || groupKeys.some((k) => appliedKeys.has(k))
      );
      const fatalOpIds = new Set((group.opIssues ?? []).filter((i) => i.severity === "error" && i.opId).map((i) => String(i.opId)));
      const fatalIssues = (group.opIssues ?? []).filter((i) => i.severity === "error");
      const writableMutations = group.mutations.filter((m) => !m.sourceOpIds.some((id) => fatalOpIds.has(id)));
      if (fatalIssues.length === 0 && group.mutations.length === 0) {
        results.push({ groupId: gid, opIds: group.opIds, status: "applied", issues: [], changedRows: 0 });
        blockedGroups.add(gid);
        continue;
      }
      if (fatalIssues.length > 0 && writableMutations.length === 0) {
        blockedGroups.add(gid);
        results.push({
          groupId: gid,
          opIds: group.opIds,
          status: "rejected",
          issues: fatalIssues.map((i) => ({ ...i, groupId: gid })),
          changedRows: 0
        });
        continue;
      }
      const savepointName = `g_${gid.replace(/[^A-Za-z0-9_]/g, "_")}`;
      savepoint(db, savepointName);
      try {
        const merged = mergeGroupMutations(writableMutations);
        let writtenRows = 0;
        for (const m of merged) {
          if (anyDuplicate && operationAlreadyApplied(db, ctx.turnId, m.sourceOpIds.join("+"), m.table, m.rowId)) {
            continue;
          }
          for (const table of [m.table]) {
            if (!isKnownTable(table)) throw new AtlasDbError("SQL_UNKNOWN_TABLE", `不在白名单的表：${table}`, { table });
          }
          applyMutation(db, m, ctx.branchId);
          writtenRows += 1;
        }
        if (validate) {
          const tables = [...new Set(merged.map((m) => m.table))].filter((t) => isKnownTable(t));
          const rowIds = [...new Set(merged.map((m) => m.rowId))];
          const pendingRows = merged.map((m) => ({ table: m.table, rowId: m.rowId, row: m.after }));
          const validation = validateGroup(db, ctx.branchId, tables, rowIds, pendingRows);
          if (!validation.ok) {
            const violations = validation.violations.slice(0, 8).map((v) => `${v.code}@${v.table}.${v.field}`).join("; ");
            throw new AtlasDbError("INVARIANT_FAILED", `组边界不变量校验失败：${violations}`, {
              violations: validation.violations
            });
          }
        }
        if (journal) {
          const rec = recordGroupChanges(
            db,
            { id: gid, mutations: merged, opIds: group.opIds },
            { turnId: ctx.turnId, attemptId: ctx.attemptId, startSequence: sequence }
          );
          journalIssues.push(...rec.issues);
          sequencesUsed += rec.written;
          sequence = rec.nextSequence;
        }
        releaseSavepoint(db, savepointName);
        for (const k of groupKeys) appliedKeys.add(k);
        const nothingWritten = writtenRows === 0 && merged.length > 0;
        results.push({
          groupId: gid,
          opIds: group.opIds,
          status: fatalIssues.length > 0 ? "rejected" : nothingWritten ? "duplicate" : "applied",
          issues: fatalIssues.map((i) => ({ ...i, groupId: gid })),
          changedRows: writtenRows
        });
      } catch (err) {
        rollbackToSavepoint(db, savepointName);
        try {
          releaseSavepoint(db, savepointName);
        } catch {
        }
        const dbErr = err;
        const code = dbErr.code ?? "SQL_CONSTRAINT";
        results.push({
          groupId: gid,
          opIds: group.opIds,
          status: "rejected",
          issues: [
            issue(code, dbErr.message ?? String(err), {
              groupId: gid,
              retryable: code !== "INVARIANT_FAILED"
            })
          ],
          changedRows: 0
        });
        blockedGroups.add(gid);
      }
    }
    const finalFk = foreignKeyCheck(db);
    if (finalFk.length > 0) {
      const summary = finalFk.map((v) => `${v.table}->${v.parent}`).join(", ");
      return {
        groups: [
          ...results,
          {
            groupId: "__foreign_key_check__",
            opIds: [],
            status: "rejected",
            issues: [
              issue("SQL_CONSTRAINT", `整批应用后外键检查未通过：${summary}`, {
                retryable: false
              })
            ],
            changedRows: 0
          }
        ],
        appliedKeys,
        sequencesUsed,
        journalIssues
      };
    }
    return { groups: results, appliedKeys, sequencesUsed, journalIssues };
  }

  // src/atlas-db-rollback.ts
  var ROLLBACK_DEFAULT_MAX_TURNS = 200;
  var ROLLBACK_DEFAULT_MAX_STEPS = 5e3;
  var NON_JOURNALED_TABLES = /* @__PURE__ */ new Set(["turns", "turn_changes", "sync_outbox"]);
  var GLOBAL_PK_TABLES = /* @__PURE__ */ new Set(["branches", "turns", "turn_changes", "sync_outbox"]);
  function refuse(code, message, path, detail) {
    const issue10 = { code, path, message, severity: "error", retryable: code !== "ROLLBACK_TOO_LARGE" };
    return new AtlasDbError(code, message, { ...detail, issues: [issue10] });
  }
  function note(code, message, extra = {}) {
    const tail = [extra.turnId ? `turn=${extra.turnId}` : "", extra.changeId ? `change=${extra.changeId}` : ""].filter((part) => part.length > 0).join(" ");
    return {
      code,
      path: "$.steps",
      message: tail ? `${message}（${tail}）` : message,
      severity: "warning",
      retryable: false
    };
  }
  function finiteOr(value, fallback) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  function positiveLimit(value, fallback) {
    if (value === void 0) return fallback;
    const n = Math.trunc(value);
    return Number.isFinite(n) && n >= 1 ? n : fallback;
  }
  function parseBefore(entry) {
    if (entry.beforeJson === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(entry.beforeJson);
    } catch (err) {
      throw refuse("ROLLBACK_PLAN_INVALID", `变更 ${entry.id} 的 before_json 损坏，无法构造恢复行：${err.message}`, "$.steps", {
        changeId: entry.id,
        turnId: entry.turnId
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw refuse("ROLLBACK_PLAN_INVALID", `变更 ${entry.id} 的 before_json 不是对象行`, "$.steps", {
        changeId: entry.id,
        turnId: entry.turnId
      });
    }
    return parsed;
  }
  function parseBasis(entry) {
    try {
      const parsed = JSON.parse(entry.basisJson);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  function planRollback(chain, limits = {}) {
    const db = chain.db;
    const branchId = String(chain.branchId ?? "");
    const targetTurnId = String(chain.targetTurnId ?? "");
    if (!branchId) throw refuse("REF_UNKNOWN", "planRollback 需要 branchId", "$.branchId", {});
    if (!targetTurnId) throw refuse("REF_UNKNOWN", "planRollback 需要 targetTurnId", "$.targetTurnId", {});
    const maxTurns = positiveLimit(limits?.maxTurns, ROLLBACK_DEFAULT_MAX_TURNS);
    const maxSteps = positiveLimit(limits?.maxSteps, ROLLBACK_DEFAULT_MAX_STEPS);
    const issues = [];
    const branch = queryBound(db, "SELECT * FROM branches WHERE id = ? LIMIT 1", [branchId])[0];
    if (!branch) throw refuse("REF_UNKNOWN", `找不到分支：${branchId}`, "$.branchId", { branchId });
    const clockBeforeS = finiteOr(branch.clock_s, 0);
    const revision = finiteOr(branch.revision, 0);
    if (chain.expectedRevision !== void 0 && Number(chain.expectedRevision) !== revision) {
      throw refuse("STALE_BASE", `回退基版本不一致：请求 ${chain.expectedRevision}，当前 ${revision}`, "$.expectedRevision", {
        branchId,
        expected: Number(chain.expectedRevision),
        current: revision
      });
    }
    const target = queryBound(db, "SELECT * FROM turns WHERE id = ? LIMIT 1", [targetTurnId])[0];
    if (!target) throw refuse("REF_UNKNOWN", `找不到要回退的 turn：${targetTurnId}`, "$.targetTurnId", { targetTurnId });
    if (String(target.branch_id) !== branchId) {
      throw refuse("REF_UNKNOWN", `目标 turn ${targetTurnId} 不属于本分支 ${branchId}`, "$.targetTurnId", {
        targetTurnId,
        turnBranchId: String(target.branch_id),
        branchId
      });
    }
    const clockTargetS = finiteOr(target.clock_before_s, Number.NaN);
    if (!Number.isFinite(clockTargetS)) {
      throw refuse("ROLLBACK_PLAN_INVALID", `目标 turn ${targetTurnId} 的 clock_before_s 不是有限数值`, "$.targetTurnId", {
        targetTurnId,
        clockBeforeS: String(target.clock_before_s)
      });
    }
    const turnRows = queryBound(db, "SELECT id, parent_turn_id, created_wall_ms FROM turns WHERE branch_id = ?", [branchId]);
    const parentOf = /* @__PURE__ */ new Map();
    const wallOf = /* @__PURE__ */ new Map();
    for (const row2 of turnRows) {
      const id = String(row2.id);
      parentOf.set(id, row2.parent_turn_id === null || row2.parent_turn_id === void 0 ? null : String(row2.parent_turn_id));
      wallOf.set(id, finiteOr(row2.created_wall_ms, 0));
    }
    const affected = new Set(collectDescendants(db, branchId, targetTurnId));
    affected.add(targetTurnId);
    if (affected.size > maxTurns) {
      throw refuse(
        "ROLLBACK_TOO_LARGE",
        `受影响 turn 数 ${affected.size} 超过上限 ${maxTurns}：明确拒绝，不截断后假装完成`,
        "$.turns",
        { affectedTurns: affected.size, maxTurns, targetTurnId }
      );
    }
    const depthOf = /* @__PURE__ */ new Map();
    depthOf.set(targetTurnId, 0);
    const children = /* @__PURE__ */ new Map();
    for (const [id, parent] of parentOf) {
      if (!parent || !affected.has(id)) continue;
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    }
    const queue = [targetTurnId];
    while (queue.length > 0) {
      const current = queue.shift();
      const depth = depthOf.get(current) ?? 0;
      for (const child of children.get(current) ?? []) {
        if (depthOf.has(child)) continue;
        depthOf.set(child, depth + 1);
        queue.push(child);
      }
    }
    const turns = [...affected].sort((a, b) => {
      const da = depthOf.get(a) ?? 0;
      const db2 = depthOf.get(b) ?? 0;
      if (da !== db2) return db2 - da;
      const wa = wallOf.get(a) ?? 0;
      const wb = wallOf.get(b) ?? 0;
      if (wa !== wb) return wa - wb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const headTurnId = branch.head_turn_id === null || branch.head_turn_id === void 0 ? null : String(branch.head_turn_id);
    const chainSet = /* @__PURE__ */ new Set();
    let cursor = headTurnId;
    while (cursor && !chainSet.has(cursor)) {
      chainSet.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    if (headTurnId && !chainSet.has(targetTurnId)) {
      issues.push({
        code: "ROLLBACK_TARGET_NOT_IN_HEAD_CHAIN",
        path: "$.targetTurnId",
        message: `目标 turn ${targetTurnId} 不在当前 head ${headTurnId} 的祖先链上（可能已经回退过）`,
        severity: "warning",
        retryable: false,
        dependencyId: headTurnId
      });
    }
    const steps = [];
    const tableCounts = {};
    let sequence = 1;
    for (const turnId of turns) {
      const entries = readTurnChanges(db, turnId);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (NON_JOURNALED_TABLES.has(entry.targetTable) || !isJournaledTable(entry.targetTable)) {
          issues.push(
            note("ROLLBACK_TABLE_NOT_JOURNALED", `表 ${entry.targetTable} 由提交/回滚控制器处理，不进 steps`, {
              turnId,
              changeId: entry.id
            })
          );
          continue;
        }
        if (entry.targetTable === "branches") {
          issues.push(
            note("ROLLBACK_BRANCH_FIELDS_FOLDED", `分支可回退字段由一条显式 step 统一表达（日志行 ${entry.id} 折入）`, {
              turnId,
              changeId: entry.id
            })
          );
          continue;
        }
        const restore = parseBefore(entry);
        steps.push({
          sequence,
          turnId,
          changeId: entry.id,
          targetTable: entry.targetTable,
          targetRowId: entry.targetRowId,
          operation: entry.operation,
          restore,
          basis: parseBasis(entry),
          summary: entry.summary
        });
        sequence += 1;
        tableCounts[entry.targetTable] = (tableCounts[entry.targetTable] ?? 0) + 1;
        if (steps.length > maxSteps) {
          throw refuse("ROLLBACK_TOO_LARGE", `回退步数超过上限 ${maxSteps}：明确拒绝，不截断后假装完成`, "$.steps", {
            maxSteps,
            targetTurnId
          });
        }
      }
    }
    const restoredCursorS = Math.min(finiteOr(branch.simulation_cursor_s, 0), clockTargetS);
    const branchRestore = { ...branch };
    branchRestore.head_turn_id = parentOf.get(targetTurnId) ?? null;
    branchRestore.revision = revision + 1;
    branchRestore.clock_s = clockTargetS;
    branchRestore.clock_min_s = clockTargetS;
    branchRestore.clock_max_s = clockTargetS;
    branchRestore.simulation_cursor_s = restoredCursorS;
    branchRestore.simulation_status = "current";
    steps.push({
      sequence,
      turnId: targetTurnId,
      changeId: `rollback_branch_${branchId}`,
      targetTable: "branches",
      targetRowId: branchId,
      operation: "update",
      restore: branchRestore,
      basis: {
        kind: "simulation",
        sources: [],
        causes: [{ kind: "turn", id: targetTurnId }],
        reason: `删楼回退：分支 clock/head/revision/cursor 恢复到 ${targetTurnId} 之前`,
        verification: "causal",
        certainty: "confirmed"
      },
      summary: `回退分支「${branchId}」：head=${String(branchRestore.head_turn_id ?? "null")}，clock=${clockTargetS}`
    });
    tableCounts.branches = (tableCounts.branches ?? 0) + 1;
    return {
      branchId,
      targetTurnId,
      turns,
      steps,
      tableCounts,
      clockBeforeS,
      clockTargetS,
      affectedTurns: turns.length,
      issues
    };
  }
  function normalizeValue2(value) {
    if (value === null || value === void 0) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "object") return JSON.stringify(value);
    return value;
  }
  function referenceGraph(db) {
    const graph = /* @__PURE__ */ new Map();
    for (const table of [...BUSINESS_TABLES, ...INTERNAL_TABLES]) {
      const parents = /* @__PURE__ */ new Set();
      try {
        for (const row2 of queryBound(db, `PRAGMA foreign_key_list(${assertSafeIdentifier(table)})`)) {
          const parent = String(row2.table ?? "");
          if (parent !== "" && parent !== table) parents.add(parent);
        }
      } catch {
      }
      graph.set(table, parents);
    }
    return graph;
  }
  function effectiveAction(step) {
    if (step.restore === null) return "delete";
    return step.operation === "delete" ? "insert" : "update";
  }
  function orderStepsByDependencies(steps, graph) {
    const n = steps.length;
    const edges = Array.from({ length: n }, () => /* @__PURE__ */ new Set());
    const indegree = new Array(n).fill(0);
    const addEdge = (from, to) => {
      if (from === to || edges[from].has(to)) return;
      edges[from].add(to);
      indegree[to] += 1;
    };
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const child = steps[i];
        const parent = steps[j];
        if (!(graph.get(child.targetTable)?.has(parent.targetTable) ?? false)) continue;
        const parentAction = effectiveAction(parent);
        if (parentAction === "delete") addEdge(i, j);
        else if (parentAction === "insert") addEdge(j, i);
      }
    }
    const ordered = [];
    const taken = new Array(n).fill(false);
    for (let count = 0; count < n; count += 1) {
      let picked = -1;
      for (let i = 0; i < n; i += 1) {
        if (!taken[i] && indegree[i] === 0) {
          picked = i;
          break;
        }
      }
      if (picked === -1) {
        for (let i = 0; i < n; i += 1) if (!taken[i]) ordered.push(steps[i]);
        break;
      }
      taken[picked] = true;
      ordered.push(steps[picked]);
      for (const next of edges[picked]) indegree[next] -= 1;
    }
    return ordered;
  }
  async function applyRollbackPlan(db, plan, ctx) {
    const issues = [...plan.issues];
    let restored = 0;
    const orderedSteps = orderStepsByDependencies(plan.steps, referenceGraph(db));
    for (const step of orderedSteps) {
      const table = step.targetTable;
      if (!isKnownTable(table) || !isJournaledTable(table) || NON_JOURNALED_TABLES.has(table)) {
        throw new AtlasDbError("ROLLBACK_PLAN_INVALID", `回退步骤指向不可回退的表：${table}`, {
          table,
          changeId: step.changeId,
          turnId: ctx.turnId,
          attemptId: ctx.attemptId
        });
      }
      assertSafeIdentifier(table);
      const allowed = new Set(tableColumnNames(table));
      const rowId = step.targetRowId;
      const isGlobal = GLOBAL_PK_TABLES.has(table);
      const whereSql = isGlobal ? "id = ?" : "branch_id = ? AND id = ?";
      const whereParams = isGlobal ? [rowId] : [plan.branchId, rowId];
      if (step.restore === null) {
        if (isGlobal) {
          throw new AtlasDbError("ROLLBACK_PLAN_INVALID", `计划要求删除 ${table} 行 ${rowId}：回退不允许删除分支或日志表`, {
            table,
            rowId,
            changeId: step.changeId
          });
        }
        runBound(db, `DELETE FROM ${table} WHERE ${whereSql}`, whereParams);
        restored += 1;
        continue;
      }
      const unknown = Object.keys(step.restore).filter((column) => !allowed.has(column));
      if (unknown.length > 0) {
        throw new AtlasDbError("ROLLBACK_PLAN_INVALID", `恢复行含 ${table} 不存在的列：${unknown.join(", ")}`, {
          table,
          rowId,
          columns: unknown
        });
      }
      const restoreBranch = step.restore.branch_id;
      if (!isGlobal && restoreBranch !== void 0 && restoreBranch !== null && String(restoreBranch) !== plan.branchId) {
        throw new AtlasDbError("ROLLBACK_PLAN_INVALID", `恢复行的 branch_id=${String(restoreBranch)} 与计划分支 ${plan.branchId} 不一致`, {
          table,
          rowId,
          branchId: plan.branchId
        });
      }
      const columns = Object.keys(step.restore);
      const values = columns.map((column) => normalizeValue2(step.restore[column]));
      if (step.operation === "delete") {
        const placeholders = columns.map(() => "?").join(", ");
        runBound(db, `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`, values);
      } else {
        const assignments = columns.map((column) => `${column} = ?`).join(", ");
        runBound(db, `UPDATE ${table} SET ${assignments} WHERE ${whereSql}`, [...values, ...whereParams]);
      }
      restored += 1;
    }
    const violations = foreignKeyCheck(db);
    if (violations.length > 0) {
      const summary = violations.map((v) => `${v.table}->${v.parent}`).join(", ");
      throw new AtlasDbError("SQL_CONSTRAINT", `回退后外键检查未通过：${summary}`, {
        violations,
        turnId: ctx.turnId,
        attemptId: ctx.attemptId
      });
    }
    return { restored, issues };
  }

  // src/atlas-ops-contract.ts
  var ATLAS_SEMANTIC_OPS = [
    "location.upsert",
    "character.upsert",
    "item.upsert",
    "item.transfer",
    "faction.upsert",
    "relation.upsert",
    "plan.propose",
    "plan.revise",
    "event.propose",
    "information.propose",
    "attention.propose",
    "channel.upsert",
    "map.estimate",
    "route.propose"
  ];
  var ATLAS_NOOP = "noop";
  function isSemanticOp(op) {
    return ATLAS_SEMANTIC_OPS.includes(op);
  }
  var PHASE_ALLOWED_OPS = {
    observe: [
      "location.upsert",
      "character.upsert",
      "item.upsert",
      "item.transfer",
      "faction.upsert",
      "relation.upsert",
      "event.propose",
      "information.propose"
    ],
    geography: ["location.upsert", "map.estimate", "route.propose"],
    decision: [
      "character.upsert",
      "relation.upsert",
      "plan.propose",
      "plan.revise",
      "attention.propose",
      "channel.upsert"
    ],
    outcome: ["event.propose", "information.propose"],
    repair: []
    // 由 allowedOpsForPhase 用原失败组的允许集合填充
  };
  var SYSTEM_OWNED_FIELDS = [
    "id",
    "branch_id",
    "branchId",
    "row_rev",
    "rowRev",
    "created_turn_id",
    "createdTurnId",
    "updated_turn_id",
    "updatedTurnId",
    "created_at_s",
    "createdAtS",
    "updated_at_s",
    "updatedAtS",
    "revision",
    "schema_version",
    "schemaVersion",
    "group_id",
    "groupId",
    "operation_id",
    "operationId",
    "basis_json",
    "basis",
    "target_table",
    "turn_id",
    "turnId",
    "chat_uid",
    "chatUid",
    "world_uid",
    "core_saved",
    "coreSaved",
    "row_id",
    "rowId",
    "rng_seed",
    "rngSeed",
    "clock_s",
    "clockS",
    "storage_revision",
    "storageRevision"
  ];
  var OP_FIELD_ALIASES = {
    locationRef: "location_ref",
    parentRef: "parent_ref",
    holderRef: "holder_ref",
    targetLocationRef: "target_location_ref",
    actionTendency: "action_tendency",
    gridX: "position.x",
    gridY: "position.y"
  };
  function allowedOpsForPhase(phase, repairAllow) {
    if (phase === "repair") return repairAllow ?? [];
    return PHASE_ALLOWED_OPS[phase] ?? [];
  }

  // src/atlas-ops-groups.ts
  function stableHash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }
  function writeKeys(mutations) {
    const set = /* @__PURE__ */ new Set();
    for (const m of mutations) set.add(`${m.table}\0${m.rowId}`);
    return set;
  }
  var UnionFind = class {
    parent;
    constructor(n) {
      this.parent = Array.from({ length: n }, (_v, i) => i);
    }
    find(i) {
      while (this.parent[i] !== i) {
        this.parent[i] = this.parent[this.parent[i]];
        i = this.parent[i];
      }
      return i;
    }
    union(a, b) {
      const ra = this.find(a);
      const rb = this.find(b);
      if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
  };
  function buildAtomicGroups(compiled) {
    const issues = [];
    const n = compiled.length;
    const uf = new UnionFind(n);
    const indexByOpId = /* @__PURE__ */ new Map();
    compiled.forEach((c, i) => indexByOpId.set(c.opId, i));
    const writeKeyOwners = /* @__PURE__ */ new Map();
    const opKeyOwners = /* @__PURE__ */ new Map();
    const entityKeyOwners = /* @__PURE__ */ new Map();
    compiled.forEach((c, i) => {
      for (const key of writeKeys(c.mutations)) {
        const owner = writeKeyOwners.get(key);
        if (owner === void 0) writeKeyOwners.set(key, i);
        else uf.union(owner, i);
      }
      for (const ek of c.entityKeyWrites ?? []) {
        const key = `${ek.kind}\0${ek.id}`;
        const owner = entityKeyOwners.get(key);
        if (owner === void 0) entityKeyOwners.set(key, i);
        else uf.union(owner, i);
      }
      for (const ok of c.operationKeys ?? []) {
        const key = `${ok.groupKey}\0${ok.opKey}`;
        const owner = opKeyOwners.get(key);
        if (owner === void 0) opKeyOwners.set(key, i);
        else uf.union(owner, i);
      }
      for (const dep of c.dependencies) {
        const target = indexByOpId.get(dep);
        if (target === void 0) {
          continue;
        }
        uf.union(target, i);
      }
    });
    const buckets = /* @__PURE__ */ new Map();
    for (let i = 0; i < n; i += 1) {
      const root = uf.find(i);
      const list = buckets.get(root);
      if (list) list.push(i);
      else buckets.set(root, [i]);
    }
    const groups = [];
    for (const memberIdx of buckets.values()) {
      const opIds = memberIdx.map((i) => compiled[i].opId);
      const mutations = [];
      const readSet = [];
      const internal = new Set(opIds);
      const dependsOn = /* @__PURE__ */ new Set();
      const opIssues = [];
      for (const i of memberIdx) {
        const c = compiled[i];
        mutations.push(...c.mutations);
        readSet.push(...c.readSet);
        if (c.issues?.length) opIssues.push(...c.issues);
        for (const dep of c.dependencies) {
          if (!internal.has(dep) && indexByOpId.has(dep)) dependsOn.add(dep);
        }
      }
      const id = `grp_${stableHash(opIds.join("|"))}`;
      groups.push({ id, opIds, dependsOn: [...dependsOn], readSet: dedupeReadSet(readSet), mutations, opIssues });
    }
    const groupOfOp = /* @__PURE__ */ new Map();
    for (const g of groups) for (const opId of g.opIds) groupOfOp.set(opId, g.id);
    const normalized = groups.map((g) => ({
      ...g,
      dependsOn: g.dependsOn.map((op) => groupOfOp.get(op) ?? op).filter((dep) => dep !== g.id)
    }));
    const writerOfRow = /* @__PURE__ */ new Map();
    for (const g of normalized) {
      for (const key of writeKeys(g.mutations)) {
        if (!writerOfRow.has(key)) writerOfRow.set(key, g.id);
      }
    }
    for (const g of normalized) {
      for (const read of g.readSet) {
        const writer = writerOfRow.get(`${read.table}\0${read.rowId}`);
        if (writer && writer !== g.id && !g.dependsOn.includes(writer)) g.dependsOn.push(writer);
      }
    }
    const merged = mergeDependencyCycles(normalized, issues);
    return { groups: merged, issues };
  }
  function dedupeReadSet(readSet) {
    const map = /* @__PURE__ */ new Map();
    for (const r of readSet) {
      const key = `${r.table}\0${r.rowId}`;
      const existing = map.get(key);
      if (!existing || r.rowRev > existing.rowRev) map.set(key, r);
    }
    return [...map.values()];
  }
  function mergeDependencyCycles(groups, issues) {
    const byId = new Map(groups.map((g) => [g.id, g]));
    const visiting = /* @__PURE__ */ new Set();
    const visited = /* @__PURE__ */ new Set();
    const cycles = [];
    const dfs = (id, stack) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        const start = stack.indexOf(id);
        if (start >= 0) cycles.push(stack.slice(start));
        return;
      }
      visiting.add(id);
      stack.push(id);
      const g = byId.get(id);
      for (const dep of g?.dependsOn ?? []) {
        if (byId.has(dep)) dfs(dep, stack);
      }
      stack.pop();
      visiting.delete(id);
      visited.add(id);
    };
    for (const g of groups) dfs(g.id, []);
    if (cycles.length === 0) return groups;
    issues.push({
      code: "GROUP_DEPENDENCY_CYCLE_MERGED",
      path: "$",
      message: `检测到 ${cycles.length} 个组间循环依赖，已合并为原子组（保持因果不可拆）`,
      severity: "warning",
      retryable: false
    });
    const uf = new UnionFind(groups.length);
    const indexById = new Map(groups.map((g, i) => [g.id, i]));
    for (const cycle of cycles) {
      const idxs = cycle.map((id) => indexById.get(id)).filter((v) => v !== void 0);
      for (let i = 1; i < idxs.length; i += 1) uf.union(idxs[0], idxs[i]);
    }
    const buckets = /* @__PURE__ */ new Map();
    groups.forEach((g, i) => {
      const root = uf.find(i);
      const list = buckets.get(root);
      if (list) list.push(g);
      else buckets.set(root, [g]);
    });
    const out = [];
    for (const members of buckets.values()) {
      if (members.length === 1) {
        out.push(members[0]);
        continue;
      }
      const memberIds = new Set(members.map((m) => m.id));
      const opIds = members.flatMap((m) => m.opIds);
      const dependsOn = /* @__PURE__ */ new Set();
      for (const m of members) {
        for (const dep of m.dependsOn) if (!memberIds.has(dep)) dependsOn.add(dep);
      }
      out.push({
        id: `grp_${stableHash(opIds.join("|"))}`,
        opIds,
        dependsOn: [...dependsOn],
        readSet: dedupeReadSet(members.flatMap((m) => m.readSet)),
        mutations: members.flatMap((m) => m.mutations)
      });
    }
    return out;
  }
  function orderGroups(groups) {
    const issues = [];
    const byId = new Map(groups.map((g) => [g.id, g]));
    const state = /* @__PURE__ */ new Map();
    const order = [];
    const blockedBy = /* @__PURE__ */ new Map();
    const stack = /* @__PURE__ */ new Set();
    const visit = (g, chain) => {
      const st = state.get(g.id);
      if (st === "done") return !blockedBy.has(g.id);
      if (stack.has(g.id)) {
        issues.push({
          code: "GROUP_ORDER_CYCLE",
          path: "$",
          message: `拓扑排序遇到未合并的循环依赖：${[...chain, g.id].join(" -> ")}`,
          severity: "error",
          retryable: false,
          groupId: g.id
        });
        return false;
      }
      stack.add(g.id);
      let ok = true;
      for (const dep of [...g.dependsOn].sort()) {
        const depGroup = byId.get(dep);
        if (!depGroup) {
          blockedBy.set(g.id, dep);
          issues.push({
            code: "DEPENDENCY_FAILED",
            path: "$",
            message: `组 ${g.id} 依赖的组 ${dep} 不存在`,
            severity: "error",
            retryable: false,
            groupId: g.id,
            dependencyId: dep
          });
          ok = false;
          continue;
        }
        if (!visit(depGroup, [...chain, g.id])) {
          if (!blockedBy.has(g.id)) blockedBy.set(g.id, dep);
          ok = false;
        }
      }
      stack.delete(g.id);
      if (ok && !blockedBy.has(g.id)) {
        state.set(g.id, "done");
        order.push(g);
        return true;
      }
      state.set(g.id, "done");
      if (!order.includes(g)) order.push(g);
      return false;
    };
    for (const g of [...groups].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      visit(g, []);
    }
    return { order, blockedBy, issues };
  }

  // src/atlas-ops-compile-types.ts
  function emptyCompileResult() {
    return { mutations: [], readSet: [], dependencies: [], issues: [] };
  }
  function mergeCompileResults(results) {
    const merged = { mutations: [], readSet: [], dependencies: [], issues: [] };
    const readMap = /* @__PURE__ */ new Map();
    for (const r of results) {
      merged.mutations.push(...r.mutations);
      merged.issues.push(...r.issues);
      for (const dep of r.dependencies) if (!merged.dependencies.includes(dep)) merged.dependencies.push(dep);
      for (const read of r.readSet) {
        const key = `${read.table}\0${read.rowId}`;
        const existing = readMap.get(key);
        if (!existing || read.rowRev > existing.rowRev) readMap.set(key, read);
      }
      if (r.entityKeyWrites?.length) merged.entityKeyWrites = [...merged.entityKeyWrites ?? [], ...r.entityKeyWrites];
      if (r.declaredRefs?.length) merged.declaredRefs = [...merged.declaredRefs ?? [], ...r.declaredRefs];
      if (r.operationKeys?.length) merged.operationKeys = [...merged.operationKeys ?? [], ...r.operationKeys];
      if (r.effects?.length) merged.effects = [...merged.effects ?? [], ...r.effects];
    }
    merged.readSet = [...readMap.values()];
    return merged;
  }

  // src/atlas-ops-refs.ts
  function refKindPrefix(kind) {
    switch (kind) {
      case "location":
        return "loc";
      case "character":
        return "chr";
      case "item":
        return "itm";
      case "faction":
        return "fac";
      case "map":
        return "map";
      case "route":
        return "rte";
      case "action":
        return "act";
      case "journey":
        return "jrn";
      case "event":
        return "evt";
      case "information":
        return "inf";
      case "knowledge":
        return "kno";
      case "channel":
        return "chn";
      case "relation":
        return "rel";
      case "rumor_front":
        return "rfr";
      case "opportunity":
        return "opp";
      case "mention":
        return "mnt";
      default:
        return "ref";
    }
  }
  var SHA256_K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  function rotr32(value, bits) {
    return (value >>> bits | value << 32 - bits) >>> 0;
  }
  function sha256Hex(text) {
    const message = new TextEncoder().encode(text);
    const paddedLength = (message.length + 8 >> 6) + 1 << 6;
    const buffer = new Uint8Array(paddedLength);
    buffer.set(message);
    buffer[message.length] = 128;
    const bitLength = message.length * 8;
    const view = new DataView(buffer.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296));
    view.setUint32(paddedLength - 4, bitLength >>> 0);
    const state = new Uint32Array([
      1779033703,
      3144134277,
      1013904242,
      2773480762,
      1359893119,
      2600822924,
      528734635,
      1541459225
    ]);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i += 1) {
        const x = w[i - 15];
        const y = w[i - 2];
        const s0 = rotr32(x, 7) ^ rotr32(x, 18) ^ x >>> 3;
        const s1 = rotr32(y, 17) ^ rotr32(y, 19) ^ y >>> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
      }
      let a = state[0];
      let b = state[1];
      let c = state[2];
      let d = state[3];
      let e = state[4];
      let f = state[5];
      let g = state[6];
      let h = state[7];
      for (let i = 0; i < 64; i += 1) {
        const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
        const ch = e & f ^ ~e & g;
        const temp1 = h + s1 + ch + SHA256_K[i] + w[i] >>> 0;
        const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
        const maj = a & b ^ a & c ^ b & c;
        const temp2 = s0 + maj >>> 0;
        h = g;
        g = f;
        f = e;
        e = d + temp1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = temp1 + temp2 >>> 0;
      }
      state[0] = state[0] + a >>> 0;
      state[1] = state[1] + b >>> 0;
      state[2] = state[2] + c >>> 0;
      state[3] = state[3] + d >>> 0;
      state[4] = state[4] + e >>> 0;
      state[5] = state[5] + f >>> 0;
      state[6] = state[6] + g >>> 0;
      state[7] = state[7] + h >>> 0;
    }
    let hex = "";
    for (let i = 0; i < 8; i += 1) hex += state[i].toString(16).padStart(8, "0");
    return hex;
  }
  var NEW_PREFIX = "new:";
  function newAliasOf(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith(NEW_PREFIX)) return null;
    const alias = trimmed.slice(NEW_PREFIX.length).trim();
    return alias.length > 0 ? alias : null;
  }
  function defaultMakeId(anchor, alias, opId, kind) {
    const digest = sha256Hex([anchor.chatUid, anchor.branchId, anchor.variantKey, alias, opId].join("\0"));
    return `${refKindPrefix(kind)}_${digest.slice(0, 24)}`;
  }
  var REFERENCE_FIELD_KINDS = {
    ref: null,
    parent_ref: null,
    location_ref: "location",
    target_location_ref: "location",
    anchor_ref: "location",
    headquarters_ref: "location",
    destination_ref: "location",
    spread_at_ref: "location",
    place_ref: "location",
    origin_ref: "location",
    via_refs: "location",
    from_ref: "location",
    to_ref: "location",
    map_ref: "map",
    item_ref: "item",
    container_ref: "item",
    event_ref: "event",
    target_event_ref: "event",
    wait_for_event_ref: "event",
    information_ref: "information",
    channel_ref: "channel",
    opportunity_ref: "opportunity",
    action_ref: "action",
    requires_action_ref: "action",
    route_ref: "route",
    // 下面这些在字段表里是「实体」而不是某一种实体；RefKind 没有 entity，
    // 因此默认按人物（最常见），具体类型由操作名或第二遍的类型检查兜住。
    holder_ref: "character",
    sender_ref: "character",
    originator_ref: "character",
    actor_ref: "character",
    recipient_ref: "character",
    subject_ref: "character",
    object_ref: "character",
    entity_ref: "character",
    entity_id: "character",
    owner_ref: "character",
    target_ref: "character",
    other_ref: "character",
    participants: "character"
  };
  var REFERENCE_FIELDS = new Set(Object.keys(REFERENCE_FIELD_KINDS));
  var OP_REF_KINDS = {
    "location.upsert": "location",
    "character.upsert": "character",
    "item.upsert": "item",
    "item.transfer": "item",
    "faction.upsert": "faction",
    "relation.upsert": "relation",
    "plan.propose": "action",
    "plan.revise": "action",
    "event.propose": "event",
    "information.propose": "information",
    "attention.propose": "knowledge",
    "channel.upsert": "channel",
    "map.estimate": "map",
    "route.propose": "route"
  };
  function kindFromOp(op) {
    const table = OP_REF_KINDS;
    return table[op] ?? null;
  }
  var MAX_SCAN_DEPTH = 12;
  function scanNewRefs(data, visit) {
    const walk = (node, field, depth) => {
      if (depth > MAX_SCAN_DEPTH) return;
      if (typeof node === "string") {
        const alias = newAliasOf(node);
        if (alias !== null && REFERENCE_FIELDS.has(field)) {
          visit({ alias, field, kind: REFERENCE_FIELD_KINDS[field] ?? null });
        }
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item, field, depth + 1);
        return;
      }
      if (node !== null && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) walk(value, key, depth + 1);
      }
    };
    if (data !== null && typeof data === "object") {
      for (const [key, value] of Object.entries(data)) walk(value, key, 1);
    }
  }
  function newAliasesOf(value) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const push = (alias) => {
      if (alias !== null && !seen.has(alias)) {
        seen.add(alias);
        out.push(alias);
      }
    };
    if (value && typeof value === "object") {
      push(newAliasOf(value.ref));
      scanNewRefs(value.data, (hit) => push(hit.alias));
    }
    return out;
  }
  function makeIssue(code, path, message, severity, retryable, where) {
    const issue10 = { code, path, message, severity, retryable };
    if (where && where.line !== void 0) issue10.line = where.line;
    if (where && where.opId !== void 0) issue10.opId = where.opId;
    if (where && where.groupId !== void 0) issue10.groupId = where.groupId;
    if (where && where.dependencyId !== void 0) issue10.dependencyId = where.dependencyId;
    return issue10;
  }
  function refPath(field) {
    if (!field) return "$.ref";
    return field.startsWith("$.") ? field : `$.data.${field}`;
  }
  function normalizeEntry(entry) {
    const alias = typeof entry.alias === "string" ? entry.alias.trim() : "";
    const bare = alias.startsWith(NEW_PREFIX) ? alias.slice(NEW_PREFIX.length).trim() : alias;
    return {
      alias: bare,
      id: typeof entry.id === "string" ? entry.id : String(entry.id),
      kind: entry.kind,
      rowRev: typeof entry.rowRev === "number" ? entry.rowRev : null,
      declaredByOpId: typeof entry.declaredByOpId === "string" ? entry.declaredByOpId : null
    };
  }
  function createRefScope(seed = []) {
    const byAlias = /* @__PURE__ */ new Map();
    const byId = /* @__PURE__ */ new Map();
    const ambiguousAliases = /* @__PURE__ */ new Set();
    const order = [];
    const orderKeys = /* @__PURE__ */ new Set();
    const remember = (entry) => {
      if (entry.alias.length === 0) return;
      const key = `${entry.alias}\0${entry.id}`;
      if (orderKeys.has(key)) return;
      orderKeys.add(key);
      order.push(entry);
    };
    const fillMissing = (target, incoming) => {
      if (target.rowRev === null && incoming.rowRev !== null) target.rowRev = incoming.rowRev;
      if (target.declaredByOpId === null && incoming.declaredByOpId !== null) {
        target.declaredByOpId = incoming.declaredByOpId;
      }
    };
    const register = (raw) => {
      const entry = normalizeEntry(raw);
      if (entry.alias.length === 0 && entry.id.length === 0) return;
      let canonical = entry;
      if (entry.alias.length > 0) {
        const existing = byAlias.get(entry.alias);
        if (!existing) {
          byAlias.set(entry.alias, entry);
        } else if (existing.id !== entry.id) {
          ambiguousAliases.add(entry.alias);
        } else {
          fillMissing(existing, entry);
          canonical = existing;
        }
      }
      if (entry.id.length > 0) {
        const existingById = byId.get(entry.id);
        if (!existingById) byId.set(entry.id, entry);
        else fillMissing(existingById, entry);
      }
      remember(canonical);
    };
    for (const entry of seed) register(entry);
    return {
      get(alias) {
        const raw = typeof alias === "string" ? alias.trim() : "";
        if (raw.length === 0) return null;
        if (!ambiguousAliases.has(raw)) {
          const direct = byAlias.get(raw);
          if (direct) return direct;
        }
        if (raw.startsWith(NEW_PREFIX)) {
          const bare = raw.slice(NEW_PREFIX.length).trim();
          if (bare.length > 0 && !ambiguousAliases.has(bare)) {
            const declared = byAlias.get(bare);
            if (declared) return declared;
          }
        }
        return byId.get(raw) ?? null;
      },
      all() {
        return [...order];
      },
      declare(entry) {
        register(entry);
      },
      byId(id) {
        const raw = typeof id === "string" ? id.trim() : "";
        if (raw.length === 0) return null;
        return byId.get(raw) ?? null;
      }
    };
  }
  function declareRefs(ops, ctx) {
    const issues = [];
    const aliasById = /* @__PURE__ */ new Map();
    const declared = [];
    const list = Array.isArray(ops) ? ops : [];
    const seedScope = createRefScope(ctx.seed ?? []);
    const makeId = ctx.makeId ?? ((kind, opId, alias) => defaultMakeId(ctx.anchor, alias, opId, kind));
    const hints = /* @__PURE__ */ new Map();
    for (const op of list) {
      scanNewRefs(op?.value?.data, (hit) => {
        if (hit.kind !== null && !hints.has(hit.alias)) hints.set(hit.alias, hit.kind);
      });
    }
    const firstDeclaration = /* @__PURE__ */ new Map();
    for (const op of list) {
      const value = op?.value;
      const refRaw = typeof value?.ref === "string" ? value.ref.trim() : "";
      const alias = newAliasOf(refRaw);
      if (alias === null) {
        if (refRaw.length > 0) {
          const seeded = seedScope.get(refRaw);
          aliasById.set(refRaw, seeded ? seeded.id : refRaw);
        }
        continue;
      }
      const previous = firstDeclaration.get(alias);
      if (previous) {
        issues.push(
          makeIssue(
            "REF_AMBIGUOUS",
            "$.ref",
            `new:${alias} 在本批被重复声明：op ${previous.opId}（第 ${previous.line} 行）与 op ${op.opId}（第 ${op.line} 行）。不静默保留第一个，必须由模型消歧或分别使用新别名。`,
            "error",
            true,
            { line: op.line, opId: op.opId }
          )
        );
        continue;
      }
      firstDeclaration.set(alias, { opId: op.opId, line: op.line });
      const opName = typeof value?.op === "string" ? value.op : "";
      const kind = kindFromOp(opName) ?? hints.get(alias) ?? "mention";
      const rawId = makeId(kind, op.opId, alias);
      const id = typeof rawId === "string" && rawId.trim().length > 0 ? rawId.trim() : defaultMakeId(ctx.anchor, alias, op.opId, kind);
      const entry = { alias, id, kind, rowRev: null, declaredByOpId: op.opId };
      declared.push(entry);
      aliasById.set(alias, id);
    }
    return { declared, aliasById, issues };
  }
  function expectedLabel(expectedKind) {
    if (expectedKind === null) return "任意类型";
    return Array.isArray(expectedKind) ? expectedKind.join("/") : expectedKind;
  }
  function kindAllowed(kind, expectedKind) {
    if (expectedKind === null) return true;
    return Array.isArray(expectedKind) ? expectedKind.includes(kind) : expectedKind === kind;
  }
  function checkKind(entry, raw, expectedKind, where) {
    if (kindAllowed(entry.kind, expectedKind)) return { entry, issues: [] };
    const opNote = where?.opId ? `（来源 op ${where.opId}）` : "";
    return {
      entry: null,
      issues: [
        makeIssue(
          "REF_TYPE_MISMATCH",
          refPath(where?.field),
          `引用「${raw}」指向 ${entry.kind}（ID ${entry.id}），此处需要 ${expectedLabel(expectedKind)}${opNote}。`,
          "error",
          true,
          { line: where?.line, opId: where?.opId }
        )
      ]
    };
  }
  function resolveRef(ref, expectedKind, scope, where) {
    const raw = typeof ref === "string" ? ref.trim() : "";
    if (raw.length === 0) {
      return {
        entry: null,
        issues: [
          makeIssue(
            "REF_UNKNOWN",
            refPath(where?.field),
            `引用为空（来源 op ${where?.opId ?? "未知"}），需要短引用、稳定 ID 或 new: 别名。`,
            "error",
            true,
            { line: where?.line, opId: where?.opId }
          )
        ]
      };
    }
    const isNew = raw.startsWith(NEW_PREFIX);
    const alias = isNew ? raw.slice(NEW_PREFIX.length).trim() : raw;
    const entries = scope.all();
    const aliasMatches = entries.filter((entry) => entry.alias === alias);
    let candidates = aliasMatches;
    if (isNew) {
      const declaredMatches = aliasMatches.filter((entry) => entry.declaredByOpId !== null);
      candidates = declaredMatches.length > 0 ? declaredMatches : [];
    }
    if (candidates.length > 0) {
      const ids = new Set(candidates.map((entry) => entry.id));
      if (ids.size > 1) {
        const detail = candidates.map((entry) => `${entry.id}（${entry.kind}${entry.declaredByOpId ? `，声明自 op ${entry.declaredByOpId}` : ""}）`).join("、");
        return {
          entry: null,
          issues: [
            makeIssue(
              "REF_AMBIGUOUS",
              refPath(where?.field),
              `引用「${raw}」匹配到多个对象：${detail}。不随机挑选，需要模型改用明确 ID 或消歧${where?.opId ? `（来源 op ${where.opId}）` : ""}。`,
              "error",
              true,
              { line: where?.line, opId: where?.opId }
            )
          ]
        };
      }
      return checkKind(candidates[0], raw, expectedKind, where);
    }
    if (isNew && aliasMatches.length > 0) {
      return {
        entry: null,
        issues: [
          makeIssue(
            "REF_UNKNOWN",
            refPath(where?.field),
            `引用「${raw}」在本批没有被任何操作以 ref:"${raw}" 声明；存在的同别名对象不是本批新建，禁止按相似名字自动合并（来源 op ${where?.opId ?? "未知"}）。`,
            "error",
            true,
            { line: where?.line, opId: where?.opId }
          )
        ]
      };
    }
    if (!isNew) {
      const byId = scope.byId(raw);
      if (byId) return checkKind(byId, raw, expectedKind, where);
    }
    return {
      entry: null,
      issues: [
        makeIssue(
          "REF_UNKNOWN",
          refPath(where?.field),
          `引用「${raw}」无法解析：既不是本批 new: 声明，也不在程序提供的短引用/稳定 ID 中（来源 op ${where?.opId ?? "未知"}）。`,
          "error",
          true,
          { line: where?.line, opId: where?.opId }
        )
      ]
    };
  }
  function collectNewAliases(ops) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const op of Array.isArray(ops) ? ops : []) {
      for (const alias of newAliasesOf(op?.value)) {
        if (!seen.has(alias)) {
          seen.add(alias);
          out.push(alias);
        }
      }
    }
    return out;
  }

  // src/atlas-ops-errors.ts
  var ATLAS_ERROR_CODES = Object.freeze({
    JSON_SYNTAX: "JSON_SYNTAX",
    WRAPPER_INCOMPLETE: "WRAPPER_INCOMPLETE",
    UNTERMINATED_REASONING: "UNTERMINATED_REASONING",
    EMPTY_RESPONSE: "EMPTY_RESPONSE",
    UNSUPPORTED_RESPONSE_FORMAT: "UNSUPPORTED_RESPONSE_FORMAT",
    RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
    TOO_MANY_OPERATIONS: "TOO_MANY_OPERATIONS",
    OPERATION_TOO_LARGE: "OPERATION_TOO_LARGE",
    JSON_TOO_DEEP: "JSON_TOO_DEEP",
    UNKNOWN_OPERATION: "UNKNOWN_OPERATION",
    MINIMUM_FIELD_MISSING: "MINIMUM_FIELD_MISSING",
    FIELD_IGNORED: "FIELD_IGNORED",
    SYSTEM_FIELD_IGNORED: "SYSTEM_FIELD_IGNORED",
    REF_UNKNOWN: "REF_UNKNOWN",
    REF_AMBIGUOUS: "REF_AMBIGUOUS",
    SOURCE_UNKNOWN: "SOURCE_UNKNOWN",
    DEPENDENCY_FAILED: "DEPENDENCY_FAILED",
    SQL_CONSTRAINT: "SQL_CONSTRAINT",
    INVARIANT_FAILED: "INVARIANT_FAILED",
    SESSION_STALE: "SESSION_STALE",
    STALE_BASE: "STALE_BASE",
    CHAT_CHANGED: "CHAT_CHANGED",
    SESSION_WRITE_FAILED: "SESSION_WRITE_FAILED",
    HOST_SAVE_UNAVAILABLE: "HOST_SAVE_UNAVAILABLE",
    HOST_SAVE_UNCONFIRMED: "HOST_SAVE_UNCONFIRMED",
    MODEL_TIMEOUT: "MODEL_TIMEOUT",
    HTTP_ERROR: "HTTP_ERROR",
    REPAIR_SCOPE_VIOLATION: "REPAIR_SCOPE_VIOLATION",
    RETRY_BASE_CHANGED: "RETRY_BASE_CHANGED",
    REPLAY_REQUIRED: "REPLAY_REQUIRED",
    WORLD_SYNC_FAILED: "WORLD_SYNC_FAILED",
    DB_WASM_LOAD_FAILED: "DB_WASM_LOAD_FAILED",
    DB_SCHEMA_UNSUPPORTED: "DB_SCHEMA_UNSUPPORTED",
    MENTION_TRACKED: "MENTION_TRACKED",
    CONDITION_UNCOMPILED: "CONDITION_UNCOMPILED",
    TIME_UNRESOLVED: "TIME_UNRESOLVED",
    INTERNAL_ERROR: "INTERNAL_ERROR"
  });
  var SECRET_RULES = [
    [/\bsk-[A-Za-z0-9_-]{4,}/gi, "[redacted]"],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, "[redacted]"],
    [
      /\b(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}["']?/gi,
      "[redacted]"
    ],
    [/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]"],
    [/[A-Za-z0-9+/]{32,}={0,2}/g, "[redacted]"]
  ];
  function redactSecrets(text) {
    if (typeof text !== "string") return String(text ?? "");
    let out = text;
    for (const [pattern, replacement] of SECRET_RULES) {
      out = out.replace(pattern, replacement);
    }
    return out;
  }
  function asRecord(value) {
    return typeof value === "object" && value !== null ? value : null;
  }
  function str(value) {
    return typeof value === "string" ? value : void 0;
  }
  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : void 0;
  }
  function safeText(error) {
    if (typeof error === "string") return error;
    const rec = asRecord(error);
    const message = rec ? str(rec["message"]) : void 0;
    if (message !== void 0) return message;
    try {
      return String(error);
    } catch {
      return "";
    }
  }
  function toIssue2(error, where = {}) {
    const rec = asRecord(error);
    const embedded = rec ? asRecord(rec["issue"]) : null;
    const hasEmbedded = embedded !== null && typeof embedded["code"] === "string" && typeof embedded["message"] === "string";
    const errorCode = rec ? str(rec["code"]) : void 0;
    const code = (errorCode !== void 0 && errorCode !== "" ? errorCode : void 0) ?? (where.code !== void 0 && where.code !== "" ? where.code : void 0) ?? (hasEmbedded ? str(embedded["code"]) : void 0) ?? ATLAS_ERROR_CODES.INTERNAL_ERROR;
    let message = where.message ?? (rec ? str(rec["message"]) : void 0);
    if (message === void 0 && hasEmbedded) message = str(embedded["message"]);
    if (message === void 0) message = safeText(error);
    if (message.trim() === "") message = `atlas error: ${code}`;
    const path = where.path ?? (rec ? str(rec["path"]) : void 0) ?? (hasEmbedded ? str(embedded["path"]) : void 0) ?? "$";
    const line = where.line ?? (rec ? num(rec["line"]) : void 0) ?? (hasEmbedded ? num(embedded["line"]) : void 0);
    const opId = where.opId ?? (rec ? str(rec["opId"]) : void 0) ?? (hasEmbedded ? str(embedded["opId"]) : void 0);
    const groupId = where.groupId ?? (rec ? str(rec["groupId"]) : void 0) ?? (hasEmbedded ? str(embedded["groupId"]) : void 0);
    const dependencyId = where.dependencyId ?? (rec ? str(rec["dependencyId"]) : void 0) ?? (hasEmbedded ? str(embedded["dependencyId"]) : void 0);
    const severity = where.severity ?? (rec?.["severity"] === "warning" || rec?.["severity"] === "error" ? rec["severity"] : void 0) ?? (hasEmbedded ? embedded["severity"] === "warning" ? "warning" : "error" : void 0) ?? "error";
    const retryable = where.retryable ?? (typeof rec?.["retryable"] === "boolean" ? rec["retryable"] : void 0) ?? (hasEmbedded && typeof embedded["retryable"] === "boolean" ? embedded["retryable"] : void 0) ?? false;
    const issue10 = {
      code,
      path,
      message: redactSecrets(message),
      severity,
      retryable
    };
    if (line !== void 0) issue10.line = line;
    if (opId !== void 0) issue10.opId = opId;
    if (groupId !== void 0) issue10.groupId = groupId;
    if (dependencyId !== void 0) issue10.dependencyId = dependencyId;
    return issue10;
  }

  // src/atlas-ops-normalize.ts
  var OP_KNOWN_FIELDS = {
    "location.upsert": [
      "name",
      "aliases",
      "kind",
      "description",
      "parent_ref",
      "mobility",
      "anchor_ref",
      "map_ref",
      "position",
      "area",
      "terrain",
      "access",
      "vehicle_profile",
      "existence_quality"
    ],
    "character.upsert": [
      "registration",
      "name",
      "aliases",
      "role",
      "identity",
      "description",
      "personality",
      "importance",
      "importance_reason",
      "thought",
      "action_tendency",
      "physical_status",
      "condition_note",
      "location_ref",
      "map_ref",
      "position",
      "mobility_profiles",
      "capabilities"
    ],
    "item.upsert": [
      "name",
      "aliases",
      "kind",
      "description",
      "quantity",
      "unit",
      "condition_note",
      "properties",
      "status",
      "placement"
    ],
    "item.transfer": ["to", "quantity", "from", "owner_ref"],
    "faction.upsert": [
      "name",
      "aliases",
      "kind",
      "description",
      "goal",
      "headquarters_ref",
      "capabilities",
      "status"
    ],
    "relation.upsert": [
      "subject_ref",
      "object_ref",
      "label",
      "kind",
      "attitude",
      "trust",
      "description",
      "secrecy",
      "ends_after_s"
    ],
    "plan.propose": ["actor_ref", "goal", "steps", "target_ref", "target_location_ref", "target_event_ref", "secrecy"],
    "plan.revise": ["change", "steps", "destination_ref", "why"],
    "event.propose": [
      "title",
      "phase",
      "kind",
      "location_ref",
      "route_ref",
      "actor_ref",
      "participants",
      "action_ref",
      "event_ref",
      "time_hint",
      "activity",
      "result",
      "effects",
      "secrecy"
    ],
    "information.propose": [
      "content",
      "title",
      "kind",
      "event_ref",
      "subject_ref",
      "origin_ref",
      "originator_ref",
      "parent_ref",
      "truth",
      "secrecy",
      "spread_at_ref",
      "recipient_ref",
      "payload"
    ],
    "attention.propose": ["opportunity_ref", "belief", "attention", "thought", "action_tendency", "reaction_goal"],
    "channel.upsert": [
      "owner_ref",
      "kind",
      "name",
      "source_ref",
      "source_location_ref",
      "recipient_ref",
      "recipient_location_ref",
      "scope",
      "requirements",
      "latency",
      "transport_mode",
      "reliability",
      "secrecy"
    ],
    "map.estimate": ["width_m", "height_m", "meters_per_cell_min", "meters_per_cell_max", "basis"],
    "route.propose": [
      "ref",
      "from_ref",
      "to_ref",
      "kind",
      "bidirectional",
      "map_ref",
      "geometry",
      "quality",
      "distance_m",
      "distance_min_m",
      "distance_max_m",
      "terrain",
      "modes",
      "access",
      "duration"
    ],
    [ATLAS_NOOP]: []
  };
  var OP_ENUM_DICTS = {
    "location.upsert": {
      kind: ["region", "city", "district", "building", "room", "natural", "vehicle", "other"],
      mobility: ["fixed", "mobile"],
      existence_quality: ["confirmed", "inferred", "hypothetical"]
    },
    "character.upsert": {
      registration: ["auto", "watch"],
      role: ["protagonist", "companion", "npc"],
      importance: ["core", "recurring", "supporting"],
      physical_status: ["alive", "incapacitated", "dead", "unknown"]
    },
    "item.upsert": {
      kind: ["object", "resource", "document", "equipment", "container", "other"],
      status: ["active", "consumed", "destroyed", "lost", "merged", "archived"]
    },
    "faction.upsert": {
      kind: ["nation", "organization", "family", "team", "other"],
      status: ["active", "dissolved", "merged", "archived"]
    },
    "relation.upsert": {
      kind: ["member_of", "leads", "controls", "knows", "kinship", "ally", "hostile", "owes", "protects", "other"],
      attitude: ["supportive", "neutral", "suspicious", "hostile", "unknown"],
      trust: ["high", "medium", "low", "unknown"],
      secrecy: ["public", "restricted", "secret"]
    },
    "plan.propose": { secrecy: ["public", "restricted", "secret"] },
    "plan.revise": { change: ["pause", "cancel", "resume", "replace_future"] },
    "event.propose": {
      phase: ["scheduled", "observed", "simulated"],
      kind: ["ceremony", "conflict", "arrival", "passage", "discovery", "trade", "communication", "incident", "other"],
      secrecy: ["public", "restricted", "secret"]
    },
    "information.propose": {
      kind: ["observation", "report", "rumor", "announcement", "lie", "hypothesis"],
      truth: ["true", "false", "mixed", "unknown"],
      secrecy: ["public", "restricted", "secret"]
    },
    "attention.propose": {
      belief: ["heard", "doubted", "believed", "verified", "rejected"],
      attention: ["low", "normal", "high"]
    },
    "channel.upsert": {
      kind: ["contact", "faction_network", "messenger", "surveillance", "broadcast", "magic", "other"],
      reliability: ["high", "medium", "low", "unknown"],
      secrecy: ["public", "restricted", "secret"]
    },
    "route.propose": {
      kind: ["adjacent", "road", "path", "door", "stairs", "air", "water", "portal", "estimated"]
    }
  };
  var ZH_ENUM_CANDIDATES = {
    公开: ["public"],
    受限: ["restricted"],
    秘密: ["secret"],
    活着: ["alive"],
    活著: ["alive"],
    存活: ["alive"],
    已死: ["dead"],
    死亡: ["dead"],
    死了: ["dead"],
    未知: ["unknown"],
    不明: ["unknown"],
    普通: ["normal", "ordinary"],
    正常: ["normal"],
    高: ["high"],
    中: ["medium"],
    中等: ["medium"],
    低: ["low"],
    支持: ["supportive"],
    中立: ["neutral"],
    怀疑: ["suspicious", "doubted"],
    存疑: ["doubted"],
    敌视: ["hostile"],
    敌对: ["hostile"],
    真: ["true"],
    假: ["false"],
    真假混合: ["mixed"],
    混合: ["mixed"],
    听到: ["heard"],
    听说: ["heard"],
    相信: ["believed"],
    证实: ["verified"],
    确认: ["confirmed", "verified"],
    拒绝: ["rejected"],
    不信: ["rejected"],
    预定: ["scheduled"],
    计划: ["scheduled"],
    观察到: ["observed"],
    已观察: ["observed"],
    推演: ["simulated"],
    模拟: ["simulated"],
    谣言: ["rumor"],
    传闻: ["rumor"],
    报告: ["report"],
    观察: ["observation", "observed", "watch"],
    宣布: ["announcement"],
    谎言: ["lie"],
    假设: ["hypothesis"],
    自动: ["auto"],
    关注: ["watch"],
    候选: ["watch"],
    主角: ["protagonist"],
    同伴: ["companion"],
    配角: ["supporting"],
    常驻: ["recurring"],
    核心: ["core"],
    国家: ["nation"],
    组织: ["organization"],
    家族: ["family"],
    团队: ["team"],
    城市: ["city"],
    区域: ["region"],
    地区: ["region"],
    建筑: ["building"],
    房间: ["room"],
    自然: ["natural"],
    载具: ["vehicle"],
    其他: ["other"],
    固定: ["fixed"],
    移动: ["mobile"],
    推断: ["inferred"],
    假设存在: ["hypothetical"],
    活跃: ["active"],
    已消耗: ["consumed"],
    销毁: ["destroyed"],
    丢失: ["lost"],
    合并: ["merged"],
    归档: ["archived"],
    解散: ["dissolved"],
    相邻: ["adjacent"],
    道路: ["road"],
    小路: ["path"],
    门: ["door"],
    楼梯: ["stairs"],
    空中: ["air"],
    水路: ["water"],
    传送门: ["portal"],
    估计: ["estimated"],
    暂停: ["pause"],
    取消: ["cancel"],
    恢复: ["resume"],
    替换未来: ["replace_future"],
    成员: ["member_of"],
    领导: ["leads"],
    首领: ["leads"],
    控制: ["controls"],
    认识: ["knows"],
    亲属: ["kinship"],
    盟友: ["ally"],
    欠: ["owes"],
    保护: ["protects"],
    联络: ["contact"],
    组织网络: ["faction_network"],
    信使: ["messenger"],
    监视: ["surveillance"],
    广播: ["broadcast"],
    魔法: ["magic"]
  };
  var NUMERIC_FIELDS = {
    "item.upsert": ["quantity"],
    "item.transfer": ["quantity"],
    "relation.upsert": ["ends_after_s"],
    "map.estimate": ["width_m", "height_m", "meters_per_cell_min", "meters_per_cell_max"],
    "route.propose": ["distance_m", "distance_min_m", "distance_max_m"]
  };
  var FULL_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
  var EXPLICIT_NON_FINITE_RE = /^[+-]?(?:infinity|inf|nan)$/i;
  var PLAN_CHANGES = ["pause", "cancel", "resume", "replace_future"];
  var EVENT_PHASES = ["scheduled", "observed", "simulated"];
  var BELIEFS = ["heard", "doubted", "believed", "verified", "rejected"];
  function issue2(code, path, message, extra = {}) {
    return toIssue2(new Error(message), { code, path, severity: "warning", ...extra });
  }
  function isPlainObject2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function hasOwn(target, key) {
    return Object.prototype.hasOwnProperty.call(target, key);
  }
  function truncateWhy(value) {
    if (value.length <= WHY_MAX_CHARS) return value;
    let out = value.slice(0, WHY_MAX_CHARS);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 55296 && last <= 56319) out = out.slice(0, -1);
    return out;
  }
  function matchEnum(value, dict) {
    const lowered = value.trim().toLowerCase();
    if (dict.includes(lowered)) return lowered;
    const candidates = ZH_ENUM_CANDIDATES[value.trim()];
    if (!candidates) return null;
    for (const candidate of candidates) {
      if (dict.includes(candidate)) return candidate;
    }
    return null;
  }
  function coerceNumeric(value, path, opName, issues) {
    const reject = (shown) => {
      issues.push(
        issue2(ATLAS_ERROR_CODES.INVARIANT_FAILED, path, `${opName}: ${path} is ${shown}; NaN/Infinity are never legal`, {
          severity: "error",
          retryable: true
        })
      );
      return { value: void 0, rejected: true };
    };
    if (typeof value === "number") {
      if (Number.isFinite(value)) return { value, rejected: false };
      return reject(String(value));
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") return { value, rejected: false };
      if (FULL_NUMBER_RE.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) return { value: parsed, rejected: false };
        return reject(JSON.stringify(value));
      }
      if (EXPLICIT_NON_FINITE_RE.test(trimmed)) return reject(JSON.stringify(value));
      return { value, rejected: false };
    }
    return { value, rejected: false };
  }
  function normalizeValues(opName, data, issues) {
    const dicts = OP_ENUM_DICTS[opName] ?? {};
    const numeric = new Set(NUMERIC_FIELDS[opName] ?? []);
    const out = {};
    for (const key of Object.keys(data)) {
      let next = data[key];
      const dict = dicts[key];
      if (dict && typeof next === "string") {
        const fixed = matchEnum(next, dict);
        if (fixed !== null) next = fixed;
      }
      if (numeric.has(key)) {
        const coerced = coerceNumeric(next, `$.data.${key}`, opName, issues);
        if (coerced.rejected) continue;
        next = coerced.value;
      }
      if (key === "position" && isPlainObject2(next)) {
        const position = { ...next };
        for (const axis of ["x", "y"]) {
          if (!hasOwn(position, axis)) continue;
          const coerced = coerceNumeric(position[axis], `$.data.position.${axis}`, opName, issues);
          if (coerced.rejected) delete position[axis];
          else position[axis] = coerced.value;
        }
        next = position;
      }
      if (key === "why" && typeof next === "string" && next.length > WHY_MAX_CHARS) {
        const truncated = truncateWhy(next);
        issues.push(
          issue2(
            ATLAS_ERROR_CODES.FIELD_IGNORED,
            "$.data.why",
            `${opName}: why is ${next.length} chars, over the ${WHY_MAX_CHARS} char limit; truncated to ${truncated.length}`
          )
        );
        next = truncated;
      }
      out[key] = next;
    }
    return out;
  }
  function normalizeOperation(raw, phase, allowedOps) {
    const issues = [];
    const ignoredFields = [];
    const systemFields = [];
    const allowed = new Set(allowedOps ?? allowedOpsForPhase(phase));
    allowed.add(ATLAS_NOOP);
    const allowedList = [...allowed].sort().join(", ");
    const opName = typeof raw?.op === "string" ? raw.op.trim() : "";
    if (opName === "" || !allowed.has(opName)) {
      const reason = opName === "" ? "operation is missing op" : isSemanticOp(opName) ? `op ${opName} is not allowed in phase ${phase}` : `unknown op ${JSON.stringify(opName)}`;
      issues.push(
        issue2(ATLAS_ERROR_CODES.UNKNOWN_OPERATION, "$.op", `${reason}; allowed: ${allowedList}`, {
          severity: "error",
          retryable: true
        })
      );
      return { op: null, issues, ignoredFields, systemFields };
    }
    const op = { op: opName };
    if (typeof raw.ref === "string") {
      const ref = raw.ref.trim();
      if (ref !== "") op.ref = ref;
    } else if (raw.ref !== void 0 && raw.ref !== null) {
      issues.push(issue2(ATLAS_ERROR_CODES.FIELD_IGNORED, "$.ref", `${opName}: ref must be a string; ignored`));
    }
    if (typeof raw.source === "string") {
      op.source = raw.source.trim();
    } else if (Array.isArray(raw.source)) {
      const list = raw.source.filter((entry) => typeof entry === "string").map((entry) => entry.trim());
      if (list.length > 0) op.source = list;
      else issues.push(issue2(ATLAS_ERROR_CODES.FIELD_IGNORED, "$.source", `${opName}: source has no usable entries; ignored`));
    } else if (raw.source !== void 0 && raw.source !== null) {
      issues.push(issue2(ATLAS_ERROR_CODES.FIELD_IGNORED, "$.source", `${opName}: source must be a string or string array; ignored`));
    }
    if (typeof raw.why === "string") {
      if (raw.why.length > WHY_MAX_CHARS) {
        op.why = truncateWhy(raw.why);
        issues.push(
          issue2(
            ATLAS_ERROR_CODES.FIELD_IGNORED,
            "$.why",
            `${opName}: why is ${raw.why.length} chars, over the ${WHY_MAX_CHARS} char limit; truncated to ${op.why.length}`
          )
        );
      } else {
        op.why = raw.why;
      }
    } else if (raw.why !== void 0 && raw.why !== null) {
      issues.push(issue2(ATLAS_ERROR_CODES.FIELD_IGNORED, "$.why", `${opName}: why must be a string; ignored`));
    }
    if (typeof raw.ticket === "string") op.ticket = raw.ticket.trim();
    let data = null;
    if (raw.data !== void 0 && raw.data !== null) {
      if (!isPlainObject2(raw.data)) {
        issues.push(issue2(ATLAS_ERROR_CODES.FIELD_IGNORED, "$.data", `${opName}: data must be an object; ignored`));
      } else {
        const sourceData = raw.data;
        const collected = {};
        for (const key of Object.keys(sourceData)) {
          const value = sourceData[key];
          if (SYSTEM_OWNED_FIELDS.includes(key) && !isKnownFieldForOp(opName, key)) {
            systemFields.push(key);
            issues.push(
              issue2(
                ATLAS_ERROR_CODES.SYSTEM_FIELD_IGNORED,
                `$.data.${key}`,
                `${opName}: program-owned field ${key} ignored`
              )
            );
            continue;
          }
          const aliasTarget = hasOwn(OP_FIELD_ALIASES, key) ? OP_FIELD_ALIASES[key] : void 0;
          if (aliasTarget !== void 0) {
            if (aliasTarget === "position.x" || aliasTarget === "position.y") {
              if (!isKnownFieldForOp(opName, "position")) {
                ignoredFields.push(key);
                issues.push(
                  issue2(ATLAS_ERROR_CODES.FIELD_IGNORED, `$.data.${key}`, `${opName}: alias ${key} → position is not a legal field; ignored`)
                );
                continue;
              }
              const axis = aliasTarget === "position.x" ? "x" : "y";
              const existing = hasOwn(collected, "position") ? collected["position"] : sourceData["position"];
              if (existing !== void 0 && existing !== null && !isPlainObject2(existing)) {
                ignoredFields.push(key);
                issues.push(
                  issue2(ATLAS_ERROR_CODES.FIELD_IGNORED, `$.data.${key}`, `${opName}: position is not an object; alias ${key} ignored`)
                );
                continue;
              }
              const position = isPlainObject2(existing) ? { ...existing } : {};
              if (hasOwn(position, axis)) {
                ignoredFields.push(key);
                issues.push(
                  issue2(ATLAS_ERROR_CODES.FIELD_IGNORED, `$.data.${key}`, `${opName}: position.${axis} already provided; alias ${key} ignored`)
                );
                collected["position"] = position;
                continue;
              }
              position[axis] = value;
              collected["position"] = position;
              continue;
            }
            if (isKnownFieldForOp(opName, aliasTarget) && !hasOwn(sourceData, aliasTarget)) {
              collected[aliasTarget] = value;
              continue;
            }
            ignoredFields.push(key);
            issues.push(
              issue2(
                ATLAS_ERROR_CODES.FIELD_IGNORED,
                `$.data.${key}`,
                `${opName}: alias ${key} → ${aliasTarget} is not usable here (target illegal or already present); ignored`
              )
            );
            continue;
          }
          if (!isKnownFieldForOp(opName, key)) {
            ignoredFields.push(key);
            issues.push(
              issue2(
                ATLAS_ERROR_CODES.FIELD_IGNORED,
                `$.data.${key}`,
                `${opName}: unknown field ${key} ignored (operation continues)`
              )
            );
            continue;
          }
          const previous = collected[key];
          collected[key] = isPlainObject2(previous) && isPlainObject2(value) ? { ...value, ...previous } : value;
        }
        data = normalizeValues(opName, collected, issues);
      }
    }
    if (data !== null) op.data = data;
    return { op, issues, ignoredFields, systemFields };
  }
  function validateMinimum(op, phase, parsed) {
    const opName = typeof op?.op === "string" ? op.op.trim() : "";
    const rawData = op?.data;
    const data = isPlainObject2(rawData) ? rawData : {};
    const ref = typeof op?.ref === "string" ? op.ref.trim() : "";
    const isNew = ref === "" || ref.startsWith("new:");
    const changed = Object.keys(data).length > 0;
    const has = (key) => hasOwn(data, key);
    const text = (key) => typeof data[key] === "string" ? data[key].trim() : "";
    const meaningful = (key) => {
      if (!has(key)) return false;
      const value = data[key];
      if (value === void 0 || value === null) return false;
      if (typeof value === "string") return value.trim() !== "";
      return true;
    };
    const missingOf = (keys) => keys.filter((key) => !meaningful(key));
    const fail = (path, message) => ({
      ok: false,
      issue: toIssue2(new Error(`${message} (phase ${phase})`), {
        code: ATLAS_ERROR_CODES.MINIMUM_FIELD_MISSING,
        path,
        line: parsed?.line,
        opId: parsed?.opId,
        severity: "error",
        retryable: true
      })
    });
    const createOrModify = (exampleName) => {
      if (isNew) {
        if (!meaningful("name")) {
          return fail(
            "$.data.name",
            `${opName} requires data.name (non-empty string) when creating; example: {"op":"${opName}","ref":"new:${exampleName}","data":{"name":"…"}}`
          );
        }
        return { ok: true };
      }
      if (!changed) {
        return fail(
          "$.data",
          `${opName} modifies an existing object: requires ref plus at least one changed field in data; example: {"op":"${opName}","ref":"${ref}","data":{"description":"…"}}`
        );
      }
      return { ok: true };
    };
    switch (opName) {
      case "location.upsert":
        return createOrModify("school");
      case "character.upsert": {
        if (text("registration").toLowerCase() === "watch") {
          if (!meaningful("name")) {
            return fail(
              "$.data.name",
              'character.upsert with registration=watch reports a candidate: requires data.name only; example: {"op":"character.upsert","data":{"registration":"watch","name":"戴兜帽的路人"}}'
            );
          }
          return { ok: true };
        }
        if (isNew) {
          if (!meaningful("name")) {
            return fail(
              "$.data.name",
              'character.upsert creating a character requires data.name; example: {"op":"character.upsert","ref":"new:elin","data":{"name":"艾琳","identity":"学校教师"}}'
            );
          }
          const clue = ["identity", "importance", "importance_reason"].some((key) => meaningful(key));
          if (!clue) {
            return fail(
              "$.data.identity",
              'character.upsert creating a formal character requires data.name plus one of identity / importance / importance_reason; example: {"op":"character.upsert","ref":"new:captain","data":{"name":"伊娜","identity":"王宫卫队长"}}'
            );
          }
          return { ok: true };
        }
        if (!changed) {
          return fail(
            "$.data",
            `character.upsert modifies an existing character: requires ref plus at least one changed field in data; example: {"op":"character.upsert","ref":"${ref}","data":{"thought":"先观察。"}}`
          );
        }
        return { ok: true };
      }
      case "item.upsert":
        return createOrModify("sword");
      case "item.transfer": {
        if (ref === "") {
          return fail(
            "$.ref",
            'item.transfer requires ref naming the transferred item; example: {"op":"item.transfer","ref":"I1","data":{"to":{"holder_ref":"C1"}}}'
          );
        }
        const to = data["to"];
        if (!isPlainObject2(to)) {
          return fail(
            "$.data.to",
            'item.transfer requires data.to with exactly one of {holder_ref} | {container_ref} | {location_ref[,position]} | {unknown:true}; example: {"op":"item.transfer","ref":"I1","data":{"to":{"holder_ref":"C1"}}}'
          );
        }
        const variants = [
          typeof to["holder_ref"] === "string" && to["holder_ref"].trim() !== "",
          typeof to["container_ref"] === "string" && to["container_ref"].trim() !== "",
          typeof to["location_ref"] === "string" && to["location_ref"].trim() !== "",
          to["unknown"] === true
        ].filter(Boolean).length;
        if (variants !== 1) {
          return fail(
            "$.data.to",
            `item.transfer requires exactly one destination form in data.to (holder_ref | container_ref | location_ref | unknown:true); got ${variants}`
          );
        }
        return { ok: true };
      }
      case "faction.upsert":
        return createOrModify("kingdom");
      case "relation.upsert": {
        if (ref !== "") return { ok: true };
        const missing = missingOf(["subject_ref", "object_ref", "label"]);
        if (missing.length > 0) {
          return fail(
            `$.data.${missing[0]}`,
            `relation.upsert requires subject_ref, object_ref and label (or ref to update an existing relation); missing: ${missing.join(", ")}; example: {"op":"relation.upsert","data":{"subject_ref":"C1","object_ref":"C2","label":"导师","kind":"knows"}}`
          );
        }
        return { ok: true };
      }
      case "plan.propose": {
        const missing = missingOf(["actor_ref", "goal"]);
        const steps = data["steps"];
        if (missing.length > 0) {
          return fail(
            `$.data.${missing[0]}`,
            `plan.propose requires actor_ref, goal and steps (array with at least one step); missing: ${missing.join(", ")}; example: {"op":"plan.propose","data":{"actor_ref":"C3","goal":"刺杀国王","steps":[{"kind":"prepare","title":"踩点"}]}}`
          );
        }
        if (!Array.isArray(steps) || steps.length === 0) {
          return fail(
            "$.data.steps",
            'plan.propose requires data.steps as an array with at least one step; example: {"op":"plan.propose","data":{"actor_ref":"C3","goal":"刺杀国王","steps":[{"kind":"prepare","title":"踩点"}]}}'
          );
        }
        return { ok: true };
      }
      case "plan.revise": {
        if (ref === "") {
          return fail(
            "$.ref",
            'plan.revise requires ref naming the plan or action being revised; example: {"op":"plan.revise","ref":"A1","data":{"change":"pause"}}'
          );
        }
        const change = text("change").toLowerCase();
        if (change === "") {
          return fail(
            "$.data.change",
            `plan.revise requires data.change ∈ {${PLAN_CHANGES.join(",")}}; example: {"op":"plan.revise","ref":"${ref}","data":{"change":"pause"}}`
          );
        }
        if (!PLAN_CHANGES.includes(change)) {
          return fail(
            "$.data.change",
            `plan.revise change must be one of {${PLAN_CHANGES.join(",")}}; got ${JSON.stringify(text("change"))}`
          );
        }
        const steps = data["steps"];
        if (change === "replace_future" && (!Array.isArray(steps) || steps.length === 0)) {
          return fail(
            "$.data.steps",
            'plan.revise with change=replace_future requires data.steps as an array with at least one step; example: {"op":"plan.revise","ref":"A1","data":{"change":"replace_future","steps":[{"kind":"travel","destination_ref":"L2"}]}}'
          );
        }
        return { ok: true };
      }
      case "event.propose": {
        if (!meaningful("title")) {
          return fail(
            "$.data.title",
            'event.propose requires data.title (non-empty string); example: {"op":"event.propose","data":{"title":"城门典礼","phase":"scheduled"}}'
          );
        }
        const eventPhase = text("phase").toLowerCase();
        if (eventPhase === "") {
          return fail(
            "$.data.phase",
            `event.propose requires data.phase ∈ {${EVENT_PHASES.join(",")}}; example: {"op":"event.propose","data":{"title":"城门典礼","phase":"scheduled"}}`
          );
        }
        if (!EVENT_PHASES.includes(eventPhase)) {
          return fail(
            "$.data.phase",
            `event.propose phase must be one of {${EVENT_PHASES.join(",")}}; got ${JSON.stringify(text("phase"))}`
          );
        }
        return { ok: true };
      }
      case "information.propose": {
        if (!meaningful("content")) {
          return fail(
            "$.data.content",
            'information.propose requires data.content (non-empty string); example: {"op":"information.propose","data":{"content":"城门今晚戒严。"}}'
          );
        }
        return { ok: true };
      }
      case "attention.propose": {
        const missing = missingOf(["opportunity_ref"]);
        if (missing.length > 0) {
          return fail(
            "$.data.opportunity_ref",
            'attention.propose requires data.opportunity_ref from the provided opportunities; example: {"op":"attention.propose","data":{"opportunity_ref":"O1","belief":"heard"}}'
          );
        }
        const belief = text("belief").toLowerCase();
        if (belief === "") {
          return fail(
            "$.data.belief",
            `attention.propose requires data.belief ∈ {${BELIEFS.join(",")}}; example: {"op":"attention.propose","data":{"opportunity_ref":"O1","belief":"heard"}}`
          );
        }
        if (!BELIEFS.includes(belief)) {
          return fail(
            "$.data.belief",
            `attention.propose belief must be one of {${BELIEFS.join(",")}}; got ${JSON.stringify(text("belief"))}`
          );
        }
        return { ok: true };
      }
      case "channel.upsert": {
        const missing = missingOf(["owner_ref", "kind", "name"]);
        if (missing.length > 0) {
          return fail(
            `$.data.${missing[0]}`,
            `channel.upsert requires owner_ref, kind and name; missing: ${missing.join(", ")}; example: {"op":"channel.upsert","data":{"owner_ref":"F1","kind":"faction_network","name":"暗卫报告网"}}`
          );
        }
        return { ok: true };
      }
      case "map.estimate": {
        if (ref === "") {
          return fail(
            "$.ref",
            'map.estimate requires ref naming the map; example: {"op":"map.estimate","ref":"M1","data":{"width_m":4200,"height_m":3100,"basis":"叙事里城市走一天"}}'
          );
        }
        const sizeKeys = ["width_m", "height_m", "meters_per_cell_min", "meters_per_cell_max", "basis"];
        if (!sizeKeys.some((key) => meaningful(key))) {
          return fail(
            "$.data.width_m",
            `map.estimate requires ref plus at least one of {${sizeKeys.join(", ")}}; example: {"op":"map.estimate","ref":"${ref}","data":{"width_m":4200,"basis":"叙事里城市走一天"}}`
          );
        }
        return { ok: true };
      }
      case "route.propose": {
        const missing = missingOf(["from_ref", "to_ref"]);
        if (missing.length > 0) {
          return fail(
            `$.data.${missing[0]}`,
            `route.propose requires from_ref and to_ref; missing: ${missing.join(", ")}; example: {"op":"route.propose","data":{"from_ref":"L1","to_ref":"L2","kind":"road"}}`
          );
        }
        return { ok: true };
      }
      case ATLAS_NOOP:
        return { ok: true };
      default:
        return {
          ok: false,
          issue: toIssue2(
            new Error(
              `unknown or unsupported op ${JSON.stringify(opName)}; supported: ${[...ATLAS_SEMANTIC_OPS, ATLAS_NOOP].join(", ")} (phase ${phase})`
            ),
            {
              code: ATLAS_ERROR_CODES.UNKNOWN_OPERATION,
              path: "$.op",
              line: parsed?.line,
              opId: parsed?.opId,
              severity: "error",
              retryable: true
            }
          )
        };
    }
  }
  function isKnownFieldForOp(op, field) {
    const list = OP_KNOWN_FIELDS[op];
    if (!list) return false;
    return list.includes(field);
  }

  // src/atlas-ops-sources.ts
  function makeIssue2(code, path, message, severity, retryable, opId, line) {
    const issue10 = { code, path, message, severity, retryable };
    if (opId !== void 0) issue10.opId = opId;
    if (line !== void 0) issue10.line = line;
    return issue10;
  }
  function truncateReason(text) {
    const value = typeof text === "string" ? text : "";
    return value.length > WHY_MAX_CHARS ? value.slice(0, WHY_MAX_CHARS) : value;
  }
  function requestedSourceKeys(source) {
    if (typeof source === "string") {
      const trimmed = source.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    }
    if (Array.isArray(source)) {
      const out = [];
      for (const item of source) {
        if (typeof item !== "string") continue;
        const trimmed = item.trim();
        if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
      }
      return out;
    }
    return [];
  }
  function opExcerpts(op) {
    const data = op?.data ?? {};
    const out = [];
    for (const key of ["excerpt", "quote", "evidence"]) {
      const value = data[key];
      if (typeof value === "string" && value.length > 0) out.push(value);
      else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.length > 0) out.push(item);
        }
      }
    }
    return out;
  }
  var MENTAL_FIELDS = [
    "thought",
    "action_tendency",
    "personality",
    "attention",
    "belief",
    "reaction_note",
    "reaction_goal",
    "attitude",
    "trust"
  ];
  function isMentalUpdate(op) {
    const name = typeof op?.op === "string" ? op.op : "";
    if (name === "attention.propose") return true;
    if (name === "plan.propose" || name === "plan.revise") return true;
    const data = op?.data;
    if (!data || typeof data !== "object") return false;
    const keys = Object.keys(data);
    if (keys.length === 0) return false;
    const mental = keys.filter((key) => MENTAL_FIELDS.includes(key));
    return mental.length > 0 && mental.length === keys.length;
  }
  var CAUSE_FIELD_KINDS = {
    action_ref: "action",
    requires_action_ref: "action",
    cause_action_ref: "action",
    event_ref: "event",
    target_event_ref: "event",
    wait_for_event_ref: "event",
    source_event_ref: "event",
    information_ref: "information",
    channel_ref: "channel",
    route_ref: "route",
    opportunity_ref: "operation",
    location_ref: "entity",
    target_location_ref: "entity",
    anchor_ref: "entity",
    headquarters_ref: "entity",
    destination_ref: "entity",
    spread_at_ref: "entity",
    place_ref: "entity",
    origin_ref: "entity",
    via_refs: "entity",
    from_ref: "entity",
    to_ref: "entity",
    holder_ref: "entity",
    container_ref: "entity",
    owner_ref: "entity",
    sender_ref: "entity",
    originator_ref: "entity",
    actor_ref: "entity",
    recipient_ref: "entity",
    subject_ref: "entity",
    object_ref: "entity",
    entity_ref: "entity",
    item_ref: "entity",
    target_ref: "entity",
    other_ref: "entity"
  };
  function causeKindFor(op, field) {
    if (field === "parent_ref") {
      return typeof op?.op === "string" && op.op.startsWith("information.") ? "information" : "entity";
    }
    const table = CAUSE_FIELD_KINDS;
    return table[field] ?? "entity";
  }
  function collectCauses(op, ctx, issues) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const opId = typeof ctx.opId === "string" && ctx.opId !== "" ? ctx.opId : void 0;
    const push = (kind, id) => {
      const trimmed = typeof id === "string" ? id.trim() : "";
      if (trimmed.length === 0) return;
      if (trimmed.startsWith("new:")) return;
      const key = `${kind}\0${trimmed}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind, id: trimmed });
    };
    for (const cause of ctx.causes ?? []) {
      if (!cause || typeof cause !== "object") continue;
      const id = typeof cause.id === "string" ? cause.id.trim() : "";
      if (id.startsWith("new:")) {
        const resolved = ctx.resolveAlias ? ctx.resolveAlias(id.slice(4)) : null;
        if (resolved) {
          push(typeof cause.kind === "string" ? cause.kind : "entity", resolved);
          continue;
        }
        issues.push(
          makeIssue2(
            "SOURCE_CAUSE_UNRESOLVED",
            "$.causes",
            `因果引用「${id}」仍是 new: 别名；causes 只接受已声明/已解析的 ID，请调用方把 declareRefs 得到的确定性 ID 放进 ctx.causes。`,
            "warning",
            false,
            opId
          )
        );
        continue;
      }
      push(typeof cause.kind === "string" ? cause.kind : "entity", id);
    }
    const data = op?.data ?? {};
    for (const [field, value] of Object.entries(data)) {
      if (!(field in CAUSE_FIELD_KINDS) && field !== "parent_ref") continue;
      const kind = causeKindFor(op, field);
      if (typeof value === "string") {
        if (value.trim().startsWith("new:")) {
          const resolvedField = ctx.resolveAlias ? ctx.resolveAlias(value.trim().slice(4)) : null;
          if (resolvedField) {
            push(kind, resolvedField);
            continue;
          }
          issues.push(
            makeIssue2(
              "SOURCE_CAUSE_UNRESOLVED",
              `$.data.${field}`,
              `因果字段「${field}」的值是未声明的 new: 别名，未写入 causes（causes 只放已声明的确定性 ID）。`,
              "warning",
              false,
              opId
            )
          );
          continue;
        }
        push(kind, value);
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") push(kind, item);
        }
      }
    }
    return out;
  }
  function defaultReason(op, ctx) {
    const name = typeof op?.op === "string" && op.op.length > 0 ? op.op : "未知操作";
    if (ctx.phase === "observe" || ctx.phase === "geography") {
      return `${ctx.phase} 阶段按本次输入快照记录 ${name}。`;
    }
    return `${ctx.phase} 阶段按后台因果推进记录 ${name}。`;
  }
  function resolveCertainty(op, ctx, boundCount) {
    const data = op?.data ?? {};
    if (data.existence_quality === "hypothetical" || data.truth === "false") return "hypothetical";
    if (isMentalUpdate(op)) return "inferred";
    if (ctx.phase === "observe" || ctx.phase === "geography") return boundCount > 0 ? "confirmed" : "inferred";
    return "inferred";
  }
  function bindSources(op, ctx) {
    const issues = [];
    const keys = requestedSourceKeys(op?.source);
    const snapshot = Array.isArray(ctx?.snapshot) ? ctx.snapshot : [];
    const byKey = /* @__PURE__ */ new Map();
    for (const entry of snapshot) {
      if (!entry || typeof entry.key !== "string") continue;
      const key = entry.key.trim();
      if (key.length > 0 && !byKey.has(key)) byKey.set(key, entry);
    }
    const causes = collectCauses(op, ctx, issues);
    const reason = truncateReason(
      typeof op?.why === "string" && op.why.trim().length > 0 ? op.why : defaultReason(op, ctx)
    );
    if (keys.length === 0) {
      if (ctx.phase === "observe" || ctx.phase === "geography") {
        const bound = snapshot.filter((entry) => entry && (entry.kind === "story" || entry.kind === "user"));
        const kind = bound.some((entry) => entry.kind === "story") ? "story" : "user";
        if (bound.length === 0) {
          issues.push(
            makeIssue2(
              "SOURCE_SNAPSHOT_EMPTY",
              "$.source",
              `${ctx.phase} 阶段省略 source，但本次来源快照里没有 story/user 条目可绑定；按 unverified 记录，不伪造来源也不阻塞该操作。`,
              "warning",
              false
            )
          );
        }
        return {
          basis: {
            kind,
            sources: bound.length === 0 ? [] : bound.map((entry) => ({ source_key: entry.key, content_hash: entry.hash, spans: [] })),
            causes,
            reason,
            verification: bound.length === 0 ? "unverified" : "source_bound",
            certainty: resolveCertainty(op, ctx, bound.length)
          },
          issues
        };
      }
      return {
        basis: {
          kind: "simulation",
          sources: [],
          causes,
          reason,
          verification: "causal",
          certainty: resolveCertainty(op, ctx, 0)
        },
        issues
      };
    }
    const unknown = [];
    const boundEntries = [];
    for (const key of keys) {
      const entry = byKey.get(key);
      if (!entry) unknown.push(key);
      else boundEntries.push(entry);
    }
    if (unknown.length > 0) {
      issues.push(
        makeIssue2(
          "SOURCE_UNKNOWN",
          "$.source",
          `请求的来源 ${unknown.map((key) => `「${key}」`).join("、")} 不在本次来源快照中；可用来源：${snapshot.map((entry) => entry.key).join("、") || "（空）"}。不伪造引文。`,
          "error",
          true,
          typeof op?.op === "string" ? op.op : void 0
        )
      );
    }
    const excerpts = opExcerpts(op);
    let locatedAny = false;
    let missedAny = false;
    const sources = [];
    for (const entry of boundEntries) {
      const text = typeof entry.text === "string" ? entry.text : "";
      const spans = [];
      let excerpt;
      const seenSpans = /* @__PURE__ */ new Set();
      for (const candidate of excerpts) {
        const at = text.indexOf(candidate);
        if (at < 0) {
          missedAny = true;
          issues.push(
            makeIssue2(
              "SOURCE_EXCERPT_NOT_FOUND",
              "$.source",
              `在来源「${entry.key}」中找不到引文（前 ${Math.min(24, candidate.length)} 字：「${candidate.slice(0, 24)}」）；保留该来源并降级为 source_bound，不编造 span。`,
              "warning",
              false,
              typeof op?.op === "string" ? op.op : void 0
            )
          );
          continue;
        }
        locatedAny = true;
        if (excerpt === void 0) excerpt = candidate;
        const span = { start: at, end: at + candidate.length };
        const spanKey = `${span.start}:${span.end}`;
        if (!seenSpans.has(spanKey)) {
          seenSpans.add(spanKey);
          spans.push(span);
        }
      }
      spans.sort((left, right) => left.start - right.start || left.end - right.end);
      const item = {
        source_key: entry.key,
        content_hash: typeof entry.hash === "string" ? entry.hash : "",
        spans
      };
      if (excerpt !== void 0) item.excerpt = excerpt;
      sources.push(item);
    }
    const primaryKind = boundEntries.length > 0 ? boundEntries[0].kind : "simulation";
    const verification = locatedAny && !missedAny ? "explicit_span" : boundEntries.length > 0 ? "source_bound" : "unverified";
    return {
      basis: {
        kind: primaryKind,
        sources,
        causes,
        reason,
        verification,
        certainty: resolveCertainty(op, ctx, boundEntries.length)
      },
      issues
    };
  }

  // src/atlas-db-defaults.ts
  var LIST_COLUMNS = /* @__PURE__ */ new Set([
    "aliases_json",
    "mobility_profiles_json",
    "capabilities_json",
    "properties_json",
    "depends_on_json",
    "participants_json",
    "allowed_modes_json",
    "segments_json",
    "recent_turn_ids_json",
    "lorebook_source_keys_json"
  ]);
  function listDefault(table, column) {
    if (!LIST_COLUMNS.has(column)) return null;
    if (table === "journeys" && column === "segments_json") return [];
    return [];
  }
  function defaultsFor(table) {
    switch (table) {
      case "maps":
        return {
          name: "",
          kind: "world",
          container_location_id: null,
          description: "",
          frame_json: { origin_x: 0, origin_y: 0, reference_width_cells: 1, reference_height_cells: 1 },
          meters_per_cell: null,
          scale_min_meters_per_cell: null,
          scale_max_meters_per_cell: null,
          scale_quality: "uncalibrated",
          scale_basis_json: { refs: [], note: "" },
          scale_locked: 0,
          calibration_rev: 1,
          background_asset_key: null,
          default_terrain: "unknown",
          status: "active"
        };
      case "locations":
        return {
          name: "",
          aliases_json: [],
          kind: "other",
          description: "",
          parent_location_id: null,
          mobility: "fixed",
          anchor_location_id: null,
          map_id: null,
          grid_x: null,
          grid_y: null,
          coord_precision: "unknown",
          uncertainty_radius_cells: null,
          area_geometry_json: null,
          terrain: "unknown",
          access_rules_json: null,
          vehicle_profile_json: null,
          existence_quality: "confirmed",
          status: "active",
          merged_into_id: null
        };
      case "characters":
        return {
          name: "",
          aliases_json: [],
          role: "npc",
          identity: "",
          description: "",
          personality: "",
          importance: "supporting",
          importance_reason: "",
          thought: "",
          action_tendency: "",
          physical_status: "unknown",
          condition_note: "",
          location_id: null,
          map_id: null,
          grid_x: null,
          grid_y: null,
          coord_precision: "unknown",
          uncertainty_radius_cells: null,
          mobility_profiles_json: [],
          capabilities_json: [],
          status: "active",
          merged_into_id: null
        };
      case "items":
        return {
          name: "",
          aliases_json: [],
          kind: "other",
          description: "",
          quantity: null,
          unit: "件",
          condition_note: "",
          owner_entity_id: null,
          holder_character_id: null,
          container_item_id: null,
          location_id: null,
          map_id: null,
          grid_x: null,
          grid_y: null,
          coord_precision: "unknown",
          uncertainty_radius_cells: null,
          properties_json: [],
          status: "active",
          merged_into_id: null
        };
      case "factions":
        return {
          name: "",
          aliases_json: [],
          kind: "other",
          description: "",
          goal: "",
          headquarters_location_id: null,
          capabilities_json: [],
          status: "active",
          merged_into_id: null
        };
      case "relations":
        return {
          subject_entity_id: "",
          object_entity_id: "",
          kind: "other",
          label: "",
          attitude: "unknown",
          trust: "unknown",
          description: "",
          basis_quality: "inferred",
          secrecy: "restricted",
          valid_from_s: 0,
          valid_until_s: null,
          status: "active"
        };
      case "routes":
        return {
          from_location_id: "",
          to_location_id: "",
          kind: "estimated",
          bidirectional: 1,
          map_id: null,
          geometry_json: null,
          geometry_quality: "unknown",
          geometry_rev: 1,
          distance_m: null,
          distance_min_m: null,
          distance_max_m: null,
          distance_basis: "unknown",
          terrain: "unknown",
          allowed_modes_json: [],
          access_rules_json: null,
          travel_time_override_json: null,
          status: "open",
          status_reason: ""
        };
      case "actions":
        return {
          actor_entity_id: "",
          parent_action_id: null,
          kind: "act",
          title: "",
          intent: "",
          target_entity_id: null,
          target_location_id: null,
          target_event_id: null,
          trigger_json: null,
          depends_on_json: [],
          payload_json: null,
          duration_json: null,
          progress_s: 0,
          earliest_start_s: null,
          deadline_s: null,
          next_check_s: null,
          started_at_s: null,
          finished_at_s: null,
          evaluated_until_s: 0,
          secrecy: "restricted",
          priority: "normal",
          status: "planned",
          reason_code: null,
          result_event_id: null
        };
      case "journeys":
        return {
          action_id: "",
          mover_entity_id: "",
          origin_location_id: "",
          destination_location_id: "",
          segments_json: [],
          segment_index: 0,
          segment_distance_done_m: null,
          segment_time_done_s: 0,
          last_reached_location_id: null,
          stop_location_id: null,
          started_at_s: 0,
          last_advanced_at_s: 0,
          estimated_arrival_min_s: null,
          estimated_arrival_max_s: null,
          arrived_at_s: null,
          position_quality: "unlocated",
          status: "moving",
          stop_reason: null
        };
      case "events":
        return {
          title: "",
          kind: "other",
          summary: "",
          location_id: null,
          route_id: null,
          route_progress_m: null,
          subject_entity_id: null,
          participants_json: [],
          cause_action_id: null,
          parent_event_id: null,
          scheduled_start_s: null,
          trigger_json: null,
          occurred_at_s: null,
          ended_at_s: null,
          outcome: "",
          secrecy: "restricted",
          status: "scheduled"
        };
      case "information":
        return {
          kind: "observation",
          title: "",
          content: "",
          source_event_id: null,
          subject_entity_id: null,
          payload_json: null,
          origin_location_id: null,
          originator_entity_id: null,
          parent_information_id: null,
          truth_status: "unknown",
          secrecy: "restricted",
          topic_key: "",
          content_hash: "",
          created_at_s: 0,
          expires_at_s: null,
          supersedes_information_id: null,
          status: "active"
        };
      case "rumor_fronts":
        return {
          information_id: "",
          location_id: "",
          via_channel_id: null,
          source_front_id: null,
          source_action_id: null,
          first_available_at_s: 0,
          last_reinforced_at_s: 0,
          next_spread_check_s: null,
          expires_at_s: null,
          reach: "local",
          audience_json: { access: "public", tags: [] },
          status: "active"
        };
      case "knowledge":
        return {
          knower_character_id: null,
          knower_faction_id: null,
          is_pov: 0,
          information_id: "",
          source_entity_id: null,
          source_front_id: null,
          source_channel_id: null,
          first_received_at_s: 0,
          last_confirmed_at_s: null,
          belief: "heard",
          attention: "normal",
          reaction_note: "",
          status: "active"
        };
      case "channels":
        return {
          name: "",
          kind: "other",
          owner_entity_id: "",
          source_entity_id: null,
          source_location_id: null,
          recipient_entity_id: null,
          recipient_location_id: null,
          scope_json: { location_refs: [], entity_refs: [], topics: [] },
          requirements_json: null,
          latency_json: { quality: "unknown", basis_refs: [] },
          transport_mode_key: null,
          reliability: "unknown",
          secrecy: "restricted",
          basis_quality: "inferred",
          valid_from_s: 0,
          valid_until_s: null,
          status: "active"
        };
      case "entity_keys":
        return { branch_id: "", id: "", kind: "location" };
      case "branches":
        return {
          parent_branch_id: null,
          fork_turn_id: null,
          head_turn_id: null,
          revision: 0,
          name: "",
          pov_character_id: null,
          root_map_id: null,
          clock_s: 0,
          clock_min_s: 0,
          clock_max_s: 0,
          calendar_label: null,
          simulation_cursor_s: 0,
          simulation_status: "current",
          ruleset_version: "",
          status: "active",
          created_wall_ms: 0
        };
      case "turns":
        return {
          branch_id: "",
          parent_turn_id: null,
          host_message_uid: null,
          host_variant_key: null,
          kind: "narrative",
          input_hash: "",
          story_hash: null,
          base_revision: 0,
          committed_revision: null,
          clock_before_s: 0,
          elapsed_json: { quality: "unknown", basis_refs: [] },
          clock_after_s: 0,
          rng_seed: "",
          ruleset_version: "",
          decisions_json: { operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] },
          receipt_json: null,
          attempts_json: [],
          status: "pending",
          created_wall_ms: 0,
          prepared_wall_ms: null
        };
      case "turn_changes":
        return {
          turn_id: "",
          sequence: 1,
          attempt_id: "",
          group_id: "",
          operation_id: "",
          target_table: "",
          target_row_id: "",
          operation: "update",
          before_json: null,
          after_json: null,
          basis_json: {},
          summary: ""
        };
      case "mention_candidates":
        return {
          name: "",
          normalized_name: "",
          context_key: "",
          kind_hint: "unknown",
          first_turn_id: "",
          last_turn_id: "",
          distinct_turn_count: 1,
          recent_turn_ids_json: [],
          context_summary: "",
          lorebook_source_keys_json: [],
          importance_hint: "none",
          promoted_entity_id: null,
          status: "watching"
        };
      case "sync_outbox":
        return {
          branch_id: "",
          requested_by_turn_id: null,
          target: "managed_lorebook",
          projection_scope: "pov",
          target_revision: 0,
          idempotency_key: "",
          payload_hash: "",
          status: "pending",
          attempt_count: 0,
          next_retry_wall_ms: null,
          last_error_code: null,
          last_error_message: null,
          created_wall_ms: 0,
          completed_wall_ms: null
        };
      default:
        return {};
    }
  }
  var COMMON_TABLE_SET = /* @__PURE__ */ new Set([
    "maps",
    "locations",
    "characters",
    "items",
    "factions",
    "relations",
    "routes",
    "actions",
    "journeys",
    "events",
    "information",
    "rumor_fronts",
    "knowledge",
    "channels"
  ]);
  function createRow(table, input, ctx) {
    if (!isKnownTable(table)) throw new Error(`CODEC_UNKNOWN_TABLE: ${String(table)}`);
    const out = { ...defaultsFor(table), ...input };
    if (COMMON_TABLE_SET.has(table)) {
      out.branch_id = ctx.branchId;
      out.id = ctx.id;
      out.row_rev = 1;
      out.created_turn_id = ctx.turnId;
      out.updated_turn_id = ctx.turnId;
    }
    if (table === "entity_keys") {
      out.branch_id = ctx.branchId;
      out.id = ctx.id;
    }
    if (table === "mention_candidates") {
      out.branch_id = ctx.branchId;
      out.id = ctx.id;
    }
    if (table === "branches") {
      out.id = ctx.id;
    }
    if (table === "turns") {
      out.id = ctx.id;
      out.branch_id = ctx.branchId;
    }
    if (table === "sync_outbox") {
      out.id = ctx.id;
      out.branch_id = ctx.branchId;
    }
    for (const key of LIST_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(out, key) && out[key] === null) {
        out[key] = listDefault(table, key);
      }
    }
    if (table === "branches") out.created_wall_ms = ctx.nowWallMs;
    if (table === "turns") out.created_wall_ms = ctx.nowWallMs;
    if (table === "sync_outbox") out.created_wall_ms = ctx.nowWallMs;
    if (table === "information" && (out.created_at_s === 0 || out.created_at_s === null)) out.created_at_s = ctx.clockS;
    if (table === "rumor_fronts") {
      if (out.first_available_at_s === 0 || out.first_available_at_s === null) out.first_available_at_s = ctx.clockS;
      if (out.last_reinforced_at_s === 0 || out.last_reinforced_at_s === null) out.last_reinforced_at_s = ctx.clockS;
    }
    if (table === "knowledge" && (out.first_received_at_s === 0 || out.first_received_at_s === null)) {
      out.first_received_at_s = ctx.clockS;
    }
    if (table === "relations" && (out.valid_from_s === 0 || out.valid_from_s === null)) out.valid_from_s = ctx.clockS;
    if (table === "channels" && (out.valid_from_s === 0 || out.valid_from_s === null)) out.valid_from_s = ctx.clockS;
    if (table === "journeys") {
      if (out.started_at_s === 0 || out.started_at_s === null) out.started_at_s = ctx.clockS;
      if (out.last_advanced_at_s === 0 || out.last_advanced_at_s === null) out.last_advanced_at_s = ctx.clockS;
    }
    if (table === "actions" && (out.evaluated_until_s === 0 || out.evaluated_until_s === null)) out.evaluated_until_s = ctx.clockS;
    if (table === "turns") {
      out.ruleset_version = out.ruleset_version || ctx.rulesetVersion;
      out.clock_before_s = out.clock_before_s ?? ctx.clockS;
      out.clock_after_s = out.clock_after_s ?? ctx.clockS;
    }
    if (table === "branches") out.ruleset_version = out.ruleset_version || ctx.rulesetVersion;
    return out;
  }

  // src/atlas-db-mentions.ts
  var MENTION_CANDIDATE_LIMIT = ATLAS_RUNTIME_LIMITS.mentionCandidates;
  var MENTION_RECENT_TURNS_LIMIT = MENTION_RECENT_LIMIT;
  var KIND_HINTS = ["character", "location", "item", "faction", "unknown"];
  var IMPORTANCE_HINTS = ["none", "review", "core"];
  var IMPORTANCE_RANK = { none: 0, review: 1, core: 2 };
  function warning(code, path, message, extra = {}) {
    return { code, path, message, severity: "warning", retryable: false, ...extra };
  }
  function decodeMentionRow(raw) {
    const decoded = decodeRow("mention_candidates", raw, { allowExtra: true });
    if (!decoded.ok) {
      throw new AtlasDbError("CODEC_DECODE_FAILED", `mention_candidates 行解码失败：${decoded.issues.map((i) => i.path).join(", ")}`, {
        issues: decoded.issues
      });
    }
    return decoded.row;
  }
  function readerFromDb(db) {
    return {
      candidatesByName: (branchId, normalizedName) => readCandidates(db, branchId, "normalized_name = ?", [normalizedName]),
      watchingCandidates: (branchId) => readCandidates(db, branchId, "status = 'watching'"),
      turnWallTimes: (branchId) => turnWallTimes(db, branchId)
    };
  }
  function readerFromPort(reads) {
    const rows2 = (where, limit) => reads.selectWhere("mention_candidates", where, limit);
    return {
      candidatesByName: (branchId, normalizedName) => rows2({ branch_id: branchId, normalized_name: normalizedName }, 1e3),
      watchingCandidates: (branchId) => rows2({ branch_id: branchId, status: "watching" }, 1e3),
      turnWallTimes: (branchId) => {
        const turns = reads.selectWhere("turns", { branch_id: branchId }, 5e3);
        const out = /* @__PURE__ */ new Map();
        for (const row2 of turns) {
          const wall = Number(row2.created_wall_ms);
          out.set(String(row2.id), Number.isFinite(wall) ? wall : 0);
        }
        return out;
      }
    };
  }
  function readCandidates(db, branchId, where = "", params = []) {
    const rows2 = queryBound(
      db,
      `SELECT * FROM mention_candidates WHERE branch_id = ?${where ? ` AND ${where}` : ""} ORDER BY id ASC`,
      [branchId, ...params]
    );
    return rows2.map(decodeMentionRow);
  }
  function stringList(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((v) => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  }
  function clampSummary(text) {
    return text.trim().slice(0, MENTION_CONTEXT_SUMMARY_CHARS);
  }
  function uniqueStrings(values, limit) {
    const out = [];
    for (const value of values) {
      if (value.length === 0 || out.includes(value)) continue;
      out.push(value);
      if (out.length >= limit) break;
    }
    return out;
  }
  function dedupeObservations(observations) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const observation of observations) {
      const name = typeof observation?.name === "string" ? observation.name.trim() : "";
      if (name.length === 0) continue;
      const key = `${normalizeName(name)}\0${(observation.identity ?? "").trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(observation);
    }
    return out;
  }
  function basisFor(turnId, reason, hasEvidence) {
    return {
      kind: "story",
      sources: [],
      causes: [{ kind: "turn", id: turnId }],
      reason,
      verification: hasEvidence ? "source_bound" : "causal",
      certainty: hasEvidence ? "confirmed" : "inferred"
    };
  }
  function hasSubstantialLorebook(observation, sourceKeys) {
    const clue = `${observation.identity ?? ""}${observation.contextSummary ?? ""}`.trim();
    return sourceKeys.length > 0 && clue.length > 0;
  }
  function desiredImportance(observation, sourceKeys, distinctTurnCount) {
    const hint = observation.importanceHint && IMPORTANCE_HINTS.includes(observation.importanceHint) ? observation.importanceHint : "none";
    if (hint === "core" || hasSubstantialLorebook(observation, sourceKeys)) return "core";
    if (distinctTurnCount >= 2) return "review";
    return hint === "review" ? "review" : "none";
  }
  function maxImportance(a, b) {
    const left = typeof a === "string" && IMPORTANCE_HINTS.includes(a) ? a : "none";
    return IMPORTANCE_RANK[left] >= IMPORTANCE_RANK[b] ? left : b;
  }
  function updateMentionCandidates(input) {
    const issues = [];
    const mutations = [];
    if (!input.db && !input.reads) {
      throw new AtlasDbError(
        "MENTION_READ_SOURCE_REQUIRED",
        "updateMentionCandidates 需要 db 或 reads 之一（只读端口即可，不能两者都缺）",
        { branchId: input.branchId }
      );
    }
    const reader = input.reads ? readerFromPort(input.reads) : readerFromDb(input.db);
    const branchId = input.branchId;
    const turnId = input.turnId;
    const makeId = input.makeId;
    const observations = dedupeObservations(input.observations ?? []);
    const byName = /* @__PURE__ */ new Map();
    const projected = /* @__PURE__ */ new Map();
    const createdInBatch = /* @__PURE__ */ new Set();
    const promoted = [];
    let created = 0;
    let updated = 0;
    for (const observation of observations) {
      const name = observation.name.trim();
      const normalized = normalizeName(name);
      if (normalized.length === 0) {
        issues.push(warning("MENTION_NAME_REQUIRED", "$.observations.name", "候选必须有非空 name"));
        continue;
      }
      const contextKey = (observation.identity ?? "").trim();
      const summary = clampSummary(observation.contextSummary ?? observation.identity ?? "");
      const sourceKeys = uniqueStrings(stringList(observation.lorebookSourceKeys), MENTION_LOREBOOK_LIMIT);
      if (observation.kindHint !== void 0 && !KIND_HINTS.includes(observation.kindHint)) {
        issues.push(warning("MENTION_KIND_INVALID", "$.observations.kindHint", `kind_hint 非法：${String(observation.kindHint)}`, { retryable: true }));
      }
      if (observation.importanceHint !== void 0 && !IMPORTANCE_HINTS.includes(observation.importanceHint)) {
        issues.push(
          warning("MENTION_IMPORTANCE_INVALID", "$.observations.importanceHint", `importance_hint 非法：${String(observation.importanceHint)}`, {
            retryable: true
          })
        );
      }
      if (!byName.has(normalized)) byName.set(normalized, reader.candidatesByName(branchId, normalized));
      const rows2 = byName.get(normalized);
      const exact = rows2.find((row2) => String(row2.context_key ?? "") === contextKey);
      const compatible = rows2.filter((row2) => {
        const existingKey = String(row2.context_key ?? "");
        if (existingKey.length === 0 || contextKey.length === 0) return true;
        return existingKey === contextKey;
      });
      const existing = exact ?? (compatible.length === 1 ? compatible[0] : null);
      if (!existing) {
        const id2 = makeId("mention", contextKey.length > 0 ? contextKey : normalized, `mention:${normalized}:${observation.kindHint ?? "unknown"}`);
        const row2 = createRow(
          "mention_candidates",
          {
            name,
            normalized_name: normalized,
            context_key: contextKey,
            kind_hint: observation.kindHint ?? "unknown",
            first_turn_id: turnId,
            last_turn_id: turnId,
            distinct_turn_count: 1,
            recent_turn_ids_json: [turnId],
            context_summary: summary,
            lorebook_source_keys_json: sourceKeys,
            importance_hint: desiredImportance(observation, sourceKeys, 1),
            promoted_entity_id: null,
            status: "watching"
          },
          { branchId, id: id2, turnId, clockS: input.clockS, nowWallMs: input.nowWallMs, rulesetVersion: input.rulesetVersion }
        );
        mutations.push({
          table: "mention_candidates",
          rowId: id2,
          before: null,
          after: row2,
          sourceOpIds: [`mention.observe:${id2}`],
          basis: basisFor(turnId, `首次提及「${name}」（${observation.kindHint ?? "unknown"}）`, summary.length > 0 || sourceKeys.length > 0)
        });
        projected.set(id2, row2);
        createdInBatch.add(id2);
        created += 1;
        continue;
      }
      const id = String(existing.id);
      const recent = uniqueStrings(stringList(existing.recent_turn_ids_json), MENTION_RECENT_TURNS_LIMIT);
      const alreadyCounted = observation.alreadyCountedThisTurn === true || recent.includes(turnId);
      const distinctBefore = Math.max(1, Number(existing.distinct_turn_count ?? 1) || 1);
      const distinctTurnCount = alreadyCounted ? distinctBefore : distinctBefore + 1;
      const recentAfter = alreadyCounted ? recent : [...recent.filter((value) => value !== turnId), turnId].slice(-MENTION_RECENT_TURNS_LIMIT);
      const status = String(existing.status ?? "watching");
      const lorebookAfter = uniqueStrings([...stringList(existing.lorebook_source_keys_json), ...sourceKeys], MENTION_LOREBOOK_LIMIT);
      const after = {
        ...existing,
        last_turn_id: turnId,
        distinct_turn_count: distinctTurnCount,
        recent_turn_ids_json: recentAfter,
        context_key: String(existing.context_key ?? "").length > 0 ? existing.context_key : contextKey,
        kind_hint: observation.kindHint && observation.kindHint !== "unknown" ? observation.kindHint : existing.kind_hint,
        context_summary: summary.length > 0 ? summary : existing.context_summary,
        lorebook_source_keys_json: lorebookAfter,
        importance_hint: maxImportance(existing.importance_hint, desiredImportance(observation, lorebookAfter, distinctTurnCount)),
        // 再次出现时把曾被淘汰的候选放回 watching；已建档（promoted）的候选保持指向实体。
        status: status === "dismissed" ? "watching" : status
      };
      mutations.push({
        table: "mention_candidates",
        rowId: id,
        before: existing,
        after,
        sourceOpIds: [`mention.observe:${id}`],
        basis: basisFor(
          turnId,
          `${alreadyCounted ? "同一楼重试" : "再次提及"}「${name}」：distinct_turn_count=${distinctTurnCount}`,
          summary.length > 0 || lorebookAfter.length > 0
        )
      });
      projected.set(id, after);
      updated += 1;
      if (String(after.status) === "promoted" && !promoted.includes(id)) promoted.push(id);
    }
    const watchingRows = reader.watchingCandidates(branchId);
    const watchingIds = new Set(watchingRows.map((row2) => String(row2.id)));
    const watchingAfter = [];
    for (const row2 of watchingRows) {
      const id = String(row2.id);
      const after = projected.get(id) ?? row2;
      if (String(after.status) === "watching") watchingAfter.push(after);
    }
    for (const [id, row2] of projected) {
      if (watchingIds.has(id)) continue;
      if (String(row2.status) === "watching") watchingAfter.push(row2);
    }
    const over = watchingAfter.length - MENTION_CANDIDATE_LIMIT;
    const evicted = [];
    if (over > 0) {
      const wallOf = reader.turnWallTimes(branchId);
      const evictable = watchingAfter.filter((row2) => !createdInBatch.has(String(row2.id))).filter((row2) => String(row2.importance_hint ?? "none") !== "core").sort((a, b) => {
        const rankA = String(a.importance_hint ?? "none") === "none" ? 0 : 1;
        const rankB = String(b.importance_hint ?? "none") === "none" ? 0 : 1;
        if (rankA !== rankB) return rankA - rankB;
        const lastA = String(a.last_turn_id ?? "");
        const lastB = String(b.last_turn_id ?? "");
        const wallA = wallOf.get(lastA) ?? 0;
        const wallB = wallOf.get(lastB) ?? 0;
        if (wallA !== wallB) return wallA - wallB;
        return lastA < lastB ? -1 : lastA > lastB ? 1 : 0;
      });
      for (const row2 of evictable) {
        if (evicted.length >= over) break;
        const id = String(row2.id);
        const after = {
          ...row2,
          // 淘汰也记到当前 turn：变更属于本楼，回退时一并恢复（不是「悄悄消失」）。
          last_turn_id: turnId,
          status: "dismissed"
        };
        mutations.push({
          table: "mention_candidates",
          rowId: id,
          before: row2,
          after,
          sourceOpIds: [`mention.evict:${id}`],
          basis: basisFor(turnId, `候选上限 ${MENTION_CANDIDATE_LIMIT} 回收：「${String(row2.name ?? "")}」长期未出现且无重要依据`, false)
        });
        projected.set(id, after);
        evicted.push(id);
      }
      const remaining = watchingAfter.length - evicted.length;
      issues.push(
        warning(
          "MENTION_EVICTED",
          "$.mention_candidates",
          `未建档候选 ${watchingAfter.length} 超过上限 ${MENTION_CANDIDATE_LIMIT}：淘汰 ${evicted.length} 条（理由：importance_hint=none 且 last_turn_id 最旧；core/promoted 不淘汰）；剩余 ${remaining}`,
          { retryable: false }
        )
      );
    }
    return { mutations, created, updated, promoted, evicted, issues };
  }
  function turnWallTimes(db, branchId) {
    const rows2 = queryBound(db, "SELECT id, created_wall_ms FROM turns WHERE branch_id = ?", [branchId]);
    const out = /* @__PURE__ */ new Map();
    for (const row2 of rows2) {
      const wall = Number(row2.created_wall_ms);
      out.set(String(row2.id), Number.isFinite(wall) ? wall : 0);
    }
    return out;
  }

  // src/atlas-ops-entities.ts
  function issue3(code, path, message, op, extra = {}) {
    return {
      code,
      path,
      message,
      severity: "error",
      retryable: true,
      opId: op.opId,
      line: op.line,
      ...extra
    };
  }
  function fieldIgnoredWarning(op, fields) {
    return {
      code: "FIELD_IGNORED",
      path: "$.data",
      message: `本操作不写这些字段，已忽略：${fields.join("、")}`,
      severity: "warning",
      retryable: false,
      opId: op.opId,
      line: op.line
    };
  }
  function isPlainObject3(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function dataOf(op) {
    return isPlainObject3(op.value.data) ? op.value.data : {};
  }
  function asString(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  function asFiniteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return null;
  }
  function applyPatch(existing, changes) {
    const out = { ...existing };
    for (const [key, value] of Object.entries(changes)) {
      if (value === void 0) continue;
      out[key] = value;
    }
    return out;
  }
  function readSetFor(ctx, table, rowId) {
    const row2 = ctx.tables.selectOne(table, ctx.branchId, rowId);
    const rowRev = row2 && typeof row2.row_rev === "number" ? row2.row_rev : 0;
    return [{ table, rowId, rowRev }];
  }
  function mutation(table, rowId, before, after, op, basis) {
    return { table, rowId, before, after, sourceOpIds: [op.opId], basis };
  }
  function turnIdOf(ctx) {
    if (typeof ctx.turnId === "string" && ctx.turnId !== "") return ctx.turnId;
    return ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
  }
  function basisFor2(ctx, op, extra = {}) {
    if (ctx.basisFor) return ctx.basisFor(op, extra);
    return {
      kind: ctx.phase === "observe" ? "story" : "simulation",
      sources: [],
      causes: extra.causes ?? [],
      reason: op.value.why ?? `${op.value.op} 语义操作`,
      verification: ctx.phase === "observe" ? "source_bound" : "causal",
      certainty: extra.certainty ?? (ctx.phase === "observe" ? "confirmed" : "inferred")
    };
  }
  function entityKeyMutation(ctx, op, id, kind) {
    const existing = ctx.tables.selectOne("entity_keys", ctx.branchId, id);
    return mutation("entity_keys", id, existing, { branch_id: ctx.branchId, id, kind }, op, basisFor2(ctx, op));
  }
  function ensureAliases(value, op, path) {
    if (value === void 0) return { value: null, issues: [] };
    if (value === null) return { value: [], issues: [] };
    if (!Array.isArray(value)) return { value: null, issues: [issue3("FIELD_TYPE_INVALID", path, "aliases 必须是字符串数组", op)] };
    const list = value.filter((v) => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
    if (list.length > ALIAS_LIMIT) {
      return {
        value: list.slice(0, ALIAS_LIMIT),
        issues: [issue3("FIELD_LIMIT_EXCEEDED", path, `aliases 最多 ${ALIAS_LIMIT} 个，收到 ${list.length} 个`, op)]
      };
    }
    return { value: list, issues: [] };
  }
  function applyPosition(target, data, op, issues, scope) {
    if (!Object.prototype.hasOwnProperty.call(data, "position")) return;
    const position = data.position;
    if (position === null) {
      target.grid_x = null;
      target.grid_y = null;
      target.map_id = null;
      target.coord_precision = "unknown";
      target.uncertainty_radius_cells = null;
      return;
    }
    if (!isPlainObject3(position)) {
      issues.push(issue3("FIELD_TYPE_INVALID", "$.data.position", "position 必须是 {x,y,precision,radius?}", op));
      return;
    }
    const x = asFiniteNumber(position.x);
    const y = asFiniteNumber(position.y);
    if (x === null || y === null) {
      issues.push(
        issue3("COORD_INCOMPLETE", "$.data.position", "position 必须同时给出有限数字 x 与 y；不知道精确位置时请省略 position", op)
      );
      return;
    }
    const precision = position.precision === void 0 ? "approximate" : String(position.precision);
    if (!["exact", "approximate", "layout", "unknown"].includes(precision)) {
      issues.push(issue3("ENUM_INVALID", "$.data.position.precision", `coord precision 取值非法：${precision}`, op));
      return;
    }
    const mapRefRaw = data.map_ref;
    if (typeof mapRefRaw !== "string" || mapRefRaw.trim() === "") {
      issues.push(issue3("COORD_MAP_REQUIRED", "$.data.map_ref", "给出坐标必须同时给出 map_ref（程序不把坐标默认挂到根图）", op));
      return;
    }
    const mapResolved = resolveRef(mapRefRaw, "map", scope, { opId: op.opId, line: op.line, field: "map_ref" });
    if (!mapResolved.entry) {
      issues.push(...mapResolved.issues);
      return;
    }
    target.map_id = mapResolved.entry.id;
    target.grid_x = x;
    target.grid_y = y;
    target.coord_precision = precision;
    const radius = asFiniteNumber(position.radius);
    target.uncertainty_radius_cells = radius !== null && radius >= 0 ? radius : null;
  }
  function ensureLocationRef(data, field, op, issues, target, targetField, expectedKind, scope) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) return;
    const raw = data[field];
    if (raw === null) {
      target[targetField] = null;
      return;
    }
    if (typeof raw !== "string" || raw.trim() === "") {
      issues.push(issue3("FIELD_TYPE_INVALID", `$.data.${field}`, `${field} 必须是引用字符串`, op));
      return;
    }
    const resolved = resolveRef(raw, expectedKind, scope, { opId: op.opId, line: op.line, field });
    if (!resolved.entry) {
      issues.push(...resolved.issues);
      return;
    }
    target[targetField] = resolved.entry.id;
  }
  function declaredRef(alias, id, kind, opId) {
    return { alias, id, kind, rowRev: null, declaredByOpId: opId };
  }
  function normalizeName(name) {
    return name.trim().replace(/\s+/g, " ").toLowerCase();
  }
  var LOCATION_FIELDS = /* @__PURE__ */ new Set([
    "name",
    "aliases",
    "kind",
    "description",
    "parent_ref",
    "mobility",
    "anchor_ref",
    "map_ref",
    "position",
    "area",
    "terrain",
    "access",
    "vehicle_profile",
    "existence_quality"
  ]);
  var LOCATION_KINDS = ["region", "city", "district", "building", "room", "natural", "vehicle", "other"];
  var LOCATION_EXISTENCE = ["confirmed", "inferred", "hypothetical"];
  function compileLocationUpsert(op, ctx) {
    const result = emptyCompileResult();
    const data = dataOf(op);
    const unknown = Object.keys(data).filter((k) => !LOCATION_FIELDS.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const ref = op.value.ref?.trim();
    const resolvingExisting = Boolean(ref) && !ref.startsWith("new:");
    const existing = resolvingExisting ? resolveRef(ref, "location", ctx.scope, { opId: op.opId, line: op.line, field: "ref" }) : null;
    if (resolvingExisting && !existing?.entry) {
      result.issues.push(...existing?.issues ?? [issue3("REF_UNKNOWN", "$.ref", `找不到地点引用：${ref}`, op)]);
      return result;
    }
    const creating = !existing?.entry;
    const rowId = existing?.entry ? existing.entry.id : ctx.makeId("location", op.opId, ref && ref.startsWith("new:") ? ref.slice(4) : `auto:${op.opId}`);
    const before = existing?.entry ? ctx.tables.selectOne("locations", ctx.branchId, rowId) : null;
    if (!creating && !before) {
      result.issues.push(issue3("REF_UNKNOWN", "$.ref", `引用存在但地点行不存在：${rowId}`, op));
      return result;
    }
    const changes = {};
    const name = asString(data.name);
    if (creating) {
      if (!name) {
        result.issues.push(issue3("MINIMUM_FIELD_MISSING", "$.data.name", "新建地点必须给 name", op));
        return result;
      }
      changes.name = name;
    } else if (Object.prototype.hasOwnProperty.call(data, "name")) {
      if (!name) {
        result.issues.push(issue3("FIELD_TYPE_INVALID", "$.data.name", "地点名称 trim 后不能为空", op));
        return result;
      }
      changes.name = name;
    }
    const aliases = ensureAliases(data.aliases, op, "$.data.aliases");
    result.issues.push(...aliases.issues);
    if (aliases.value) changes.aliases_json = aliases.value;
    if (Object.prototype.hasOwnProperty.call(data, "kind")) {
      const kind = String(data.kind);
      if (!LOCATION_KINDS.includes(kind)) result.issues.push(issue3("ENUM_INVALID", "$.data.kind", `地点类型非法：${kind}`, op));
      else changes.kind = kind;
    }
    if (Object.prototype.hasOwnProperty.call(data, "description")) changes.description = String(data.description ?? "");
    if (Object.prototype.hasOwnProperty.call(data, "terrain")) changes.terrain = asString(data.terrain) ?? "unknown";
    if (Object.prototype.hasOwnProperty.call(data, "mobility")) {
      const mobility = String(data.mobility);
      if (!["fixed", "mobile"].includes(mobility)) result.issues.push(issue3("ENUM_INVALID", "$.data.mobility", `mobility 非法：${mobility}`, op));
      else changes.mobility = mobility;
    }
    if (Object.prototype.hasOwnProperty.call(data, "existence_quality")) {
      const q = String(data.existence_quality);
      if (!LOCATION_EXISTENCE.includes(q)) result.issues.push(issue3("ENUM_INVALID", "$.data.existence_quality", `existence_quality 非法：${q}`, op));
      else changes.existence_quality = q;
    }
    if (Object.prototype.hasOwnProperty.call(data, "access")) changes.access_rules_json = data.access ?? null;
    if (Object.prototype.hasOwnProperty.call(data, "area")) changes.area_geometry_json = data.area ?? null;
    if (Object.prototype.hasOwnProperty.call(data, "vehicle_profile")) changes.vehicle_profile_json = data.vehicle_profile ?? null;
    ensureLocationRef(data, "parent_ref", op, result.issues, changes, "parent_location_id", ["location"], ctx.scope);
    ensureLocationRef(data, "anchor_ref", op, result.issues, changes, "anchor_location_id", ["location"], ctx.scope);
    applyPosition(changes, data, op, result.issues, ctx.scope);
    if (result.issues.some((i) => i.severity === "error")) return result;
    if (creating) {
      const row2 = createRow("locations", { ...changes }, {
        branchId: ctx.branchId,
        id: rowId,
        turnId: turnIdOf(ctx),
        clockS: ctx.clockS,
        nowWallMs: Date.now(),
        rulesetVersion: "atlas-1"
      });
      result.mutations.push(entityKeyMutation(ctx, op, rowId, "location"));
      result.mutations.push(mutation("locations", rowId, null, row2, op, basisFor2(ctx, op)));
      result.entityKeyWrites = [{ id: rowId, kind: "location" }];
    } else {
      const merged = applyPatch(before, changes);
      if (merged.parent_location_id === rowId) {
        result.issues.push(issue3("INVARIANT_LOCATION_PARENT_CYCLE", "$.data.parent_ref", "地点不能以自己为父地点", op));
        return result;
      }
      merged.row_rev = Number(before.row_rev ?? 1) + 1;
      merged.updated_turn_id = turnIdOf(ctx);
      result.mutations.push(mutation("locations", rowId, before, merged, op, basisFor2(ctx, op)));
      result.readSet.push(...readSetFor(ctx, "locations", rowId));
    }
    result.declaredRefs = ref?.startsWith("new:") ? [declaredRef(ref, rowId, "location", op.opId)] : [];
    return result;
  }
  var CHARACTER_FIELDS = /* @__PURE__ */ new Set([
    "registration",
    "name",
    "aliases",
    "role",
    "identity",
    "description",
    "personality",
    "importance",
    "importance_reason",
    "thought",
    "action_tendency",
    "physical_status",
    "condition_note",
    "location_ref",
    "map_ref",
    "position",
    "mobility_profiles",
    "capabilities"
  ]);
  var CHARACTER_ROLES = ["protagonist", "companion", "npc"];
  var CHARACTER_IMPORTANCE = ["core", "recurring", "supporting"];
  var CHARACTER_PHYSICAL = ["alive", "incapacitated", "dead", "unknown"];
  function mentionMutations(ctx, op, params) {
    const observed = updateMentionCandidates({
      reads: ctx.tables,
      branchId: ctx.branchId,
      turnId: turnIdOf(ctx),
      clockS: ctx.clockS,
      nowWallMs: Date.now(),
      rulesetVersion: "atlas-1",
      observations: [
        {
          name: params.name,
          kindHint: "character",
          identity: params.identity,
          contextSummary: params.identity,
          lorebookSourceKeys: params.sourceKeys,
          importanceHint: params.importanceHint
        }
      ],
      makeId: (kind, opId, alias) => ctx.makeId(kind, opId, alias)
    });
    void op;
    return { mutations: observed.mutations, issues: observed.issues };
  }
  function compileCharacterUpsert(op, ctx) {
    const result = emptyCompileResult();
    const data = dataOf(op);
    const unknown = Object.keys(data).filter((k) => !CHARACTER_FIELDS.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const ref = op.value.ref?.trim();
    const registration = data.registration === void 0 ? "auto" : String(data.registration);
    if (!["auto", "watch"].includes(registration)) {
      result.issues.push(issue3("ENUM_INVALID", "$.data.registration", `registration 非法：${registration}`, op));
      return result;
    }
    const resolvingExisting = Boolean(ref) && !ref.startsWith("new:");
    const existing = resolvingExisting ? resolveRef(ref, "character", ctx.scope, { opId: op.opId, line: op.line, field: "ref" }) : null;
    if (resolvingExisting && !existing?.entry) {
      result.issues.push(...existing?.issues ?? [issue3("REF_UNKNOWN", "$.ref", `找不到人物引用：${ref}`, op)]);
      return result;
    }
    const creating = !existing?.entry;
    const name = asString(data.name);
    const identity = asString(data.identity) ?? "";
    const importanceReason = asString(data.importance_reason);
    const hasImportance = Object.prototype.hasOwnProperty.call(data, "importance") || importanceReason !== null;
    const hasBootstrapHint = identity !== "" || hasImportance;
    const sourceKeys = Array.isArray(op.value.source) ? op.value.source : op.value.source ? [op.value.source] : [];
    if (registration === "watch" && creating) {
      if (!name) {
        result.issues.push(issue3("MINIMUM_FIELD_MISSING", "$.data.name", "watch 候选至少需要 name", op));
        return result;
      }
      const mention = mentionMutations(ctx, op, { name, identity, importanceHint: "review", sourceKeys });
      result.mutations.push(...mention.mutations);
      result.issues.push(...mention.issues);
      result.issues.push({
        code: "MENTION_TRACKED",
        path: "$.data.name",
        message: `「${name}」只进入临时提及候选，未创建人物实体（registration=watch）`,
        severity: "warning",
        retryable: false,
        opId: op.opId,
        line: op.line
      });
      return result;
    }
    if (creating && !hasBootstrapHint) {
      if (name) {
        const mention = mentionMutations(ctx, op, { name, identity, importanceHint: "review", sourceKeys });
        result.mutations.push(...mention.mutations);
        result.issues.push(...mention.issues);
        result.issues.push({
          code: "MENTION_TRACKED",
          path: "$.data.name",
          message: `「${name}」尚无身份/重要性线索，先记为临时提及候选，不创建人物实体`,
          severity: "warning",
          retryable: false,
          opId: op.opId,
          line: op.line
        });
        return result;
      }
      result.issues.push(
        issue3("MINIMUM_FIELD_MISSING", "$.data.name", "新建人物必须给 name，并至少给 identity / importance / importance_reason 之一", op)
      );
      return result;
    }
    const rowId = existing?.entry ? existing.entry.id : ctx.makeId("character", op.opId, ref && ref.startsWith("new:") ? ref.slice(4) : `auto:${op.opId}`);
    const before = existing?.entry ? ctx.tables.selectOne("characters", ctx.branchId, rowId) : null;
    if (!creating && !before) {
      result.issues.push(issue3("REF_UNKNOWN", "$.ref", `引用存在但人物行不存在：${rowId}`, op));
      return result;
    }
    const changes = {};
    if (creating) {
      changes.name = name;
    } else if (Object.prototype.hasOwnProperty.call(data, "name")) {
      if (!name) {
        result.issues.push(issue3("FIELD_TYPE_INVALID", "$.data.name", "人物名称 trim 后不能为空", op));
        return result;
      }
      changes.name = name;
    }
    const aliases = ensureAliases(data.aliases, op, "$.data.aliases");
    result.issues.push(...aliases.issues);
    if (aliases.value) changes.aliases_json = aliases.value;
    if (Object.prototype.hasOwnProperty.call(data, "role")) {
      const role = String(data.role);
      if (!CHARACTER_ROLES.includes(role)) result.issues.push(issue3("ENUM_INVALID", "$.data.role", `role 非法：${role}`, op));
      else changes.role = role;
    }
    if (Object.prototype.hasOwnProperty.call(data, "importance")) {
      const importance = String(data.importance);
      if (!CHARACTER_IMPORTANCE.includes(importance)) result.issues.push(issue3("ENUM_INVALID", "$.data.importance", `importance 非法：${importance}`, op));
      else changes.importance = importance;
    }
    if (Object.prototype.hasOwnProperty.call(data, "physical_status")) {
      const st = String(data.physical_status);
      if (!CHARACTER_PHYSICAL.includes(st)) result.issues.push(issue3("ENUM_INVALID", "$.data.physical_status", `physical_status 非法：${st}`, op));
      else changes.physical_status = st;
    }
    for (const field of ["identity", "description", "personality", "thought", "action_tendency", "condition_note"]) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        changes[field] = typeof data[field] === "string" ? data[field] : data[field] === null ? "" : String(data[field]);
      }
    }
    if (Object.prototype.hasOwnProperty.call(data, "importance_reason")) {
      changes.importance_reason = typeof data.importance_reason === "string" ? data.importance_reason : String(data.importance_reason ?? "");
    }
    if (Object.prototype.hasOwnProperty.call(data, "mobility_profiles")) {
      const list = Array.isArray(data.mobility_profiles) ? data.mobility_profiles : null;
      if (!list) result.issues.push(issue3("FIELD_TYPE_INVALID", "$.data.mobility_profiles", "mobility_profiles 必须是数组", op));
      else if (list.length > MOBILITY_PROFILE_LIMIT) result.issues.push(issue3("FIELD_LIMIT_EXCEEDED", "$.data.mobility_profiles", `最多 ${MOBILITY_PROFILE_LIMIT} 种移动方式`, op));
      else changes.mobility_profiles_json = list;
    }
    if (Object.prototype.hasOwnProperty.call(data, "capabilities")) {
      const list = Array.isArray(data.capabilities) ? data.capabilities : null;
      if (!list) result.issues.push(issue3("FIELD_TYPE_INVALID", "$.data.capabilities", "capabilities 必须是数组", op));
      else if (list.length > CAPABILITY_LIMIT) result.issues.push(issue3("FIELD_LIMIT_EXCEEDED", "$.data.capabilities", `最多 ${CAPABILITY_LIMIT} 项能力`, op));
      else changes.capabilities_json = list;
    }
    if (ctx.phase === "decision" && !creating) {
      const allowed = /* @__PURE__ */ new Set(["thought", "action_tendency", "importance", "importance_reason", "condition_note", "physical_status"]);
      const illegal = Object.keys(changes).filter((k) => !allowed.has(k));
      if (illegal.length) {
        result.issues.push(
          issue3("PHASE_FIELD_NOT_ALLOWED", "$.data", `decision 阶段不得修改这些字段：${illegal.join("、")}（本阶段只写想法/倾向/注意）`, op)
        );
        return result;
      }
    }
    ensureLocationRef(data, "location_ref", op, result.issues, changes, "location_id", ["location"], ctx.scope);
    applyPosition(changes, data, op, result.issues, ctx.scope);
    if (result.issues.some((i) => i.severity === "error")) return result;
    if (creating) {
      const row2 = createRow("characters", { ...changes }, {
        branchId: ctx.branchId,
        id: rowId,
        turnId: turnIdOf(ctx),
        clockS: ctx.clockS,
        nowWallMs: Date.now(),
        rulesetVersion: "atlas-1"
      });
      result.mutations.push(entityKeyMutation(ctx, op, rowId, "character"));
      result.mutations.push(mutation("characters", rowId, null, row2, op, basisFor2(ctx, op)));
      result.entityKeyWrites = [{ id: rowId, kind: "character" }];
    } else {
      const merged = applyPatch(before, changes);
      merged.row_rev = Number(before.row_rev ?? 1) + 1;
      merged.updated_turn_id = turnIdOf(ctx);
      result.mutations.push(mutation("characters", rowId, before, merged, op, basisFor2(ctx, op)));
      result.readSet.push(...readSetFor(ctx, "characters", rowId));
    }
    result.declaredRefs = ref?.startsWith("new:") ? [declaredRef(ref, rowId, "character", op.opId)] : [];
    return result;
  }
  var ITEM_FIELDS = /* @__PURE__ */ new Set([
    "name",
    "aliases",
    "kind",
    "description",
    "quantity",
    "unit",
    "condition_note",
    "properties",
    "status",
    "placement"
  ]);
  var ITEM_KINDS = ["object", "resource", "document", "equipment", "container", "other"];
  var ITEM_STATUS = ["active", "consumed", "destroyed", "lost", "merged", "archived"];
  function compileItemUpsert(op, ctx) {
    const result = emptyCompileResult();
    const data = dataOf(op);
    const unknown = Object.keys(data).filter((k) => !ITEM_FIELDS.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const ref = op.value.ref?.trim();
    const resolvingExisting = Boolean(ref) && !ref.startsWith("new:");
    const existing = resolvingExisting ? resolveRef(ref, "item", ctx.scope, { opId: op.opId, line: op.line, field: "ref" }) : null;
    if (resolvingExisting && !existing?.entry) {
      result.issues.push(...existing?.issues ?? [issue3("REF_UNKNOWN", "$.ref", `找不到物品引用：${ref}`, op)]);
      return result;
    }
    const creating = !existing?.entry;
    const name = asString(data.name);
    if (creating && !name) {
      result.issues.push(issue3("MINIMUM_FIELD_MISSING", "$.data.name", "新建物品必须给 name", op));
      return result;
    }
    const rowId = existing?.entry ? existing.entry.id : ctx.makeId("item", op.opId, ref && ref.startsWith("new:") ? ref.slice(4) : `auto:${op.opId}`);
    const before = existing?.entry ? ctx.tables.selectOne("items", ctx.branchId, rowId) : null;
    if (!creating && !before) {
      result.issues.push(issue3("REF_UNKNOWN", "$.ref", `引用存在但物品行不存在：${rowId}`, op));
      return result;
    }
    const changes = {};
    if (creating) changes.name = name;
    else if (Object.prototype.hasOwnProperty.call(data, "name")) changes.name = name;
    const aliases = ensureAliases(data.aliases, op, "$.data.aliases");
    result.issues.push(...aliases.issues);
    if (aliases.value) changes.aliases_json = aliases.value;
    if (Object.prototype.hasOwnProperty.call(data, "kind")) {
      const kind = String(data.kind);
      if (!ITEM_KINDS.includes(kind)) result.issues.push(issue3("ENUM_INVALID", "$.data.kind", `物品类别非法：${kind}`, op));
      else changes.kind = kind;
    }
    if (Object.prototype.hasOwnProperty.call(data, "status")) {
      const st = String(data.status);
      if (!ITEM_STATUS.includes(st)) result.issues.push(issue3("ENUM_INVALID", "$.data.status", `物品状态非法：${st}`, op));
      else changes.status = st;
    }
    if (Object.prototype.hasOwnProperty.call(data, "description")) changes.description = String(data.description ?? "");
    if (Object.prototype.hasOwnProperty.call(data, "condition_note")) changes.condition_note = String(data.condition_note ?? "");
    if (Object.prototype.hasOwnProperty.call(data, "unit")) changes.unit = asString(data.unit) ?? "件";
    if (Object.prototype.hasOwnProperty.call(data, "quantity")) {
      if (data.quantity === null) {
        changes.quantity = null;
      } else {
        const q = asFiniteNumber(data.quantity);
        if (q === null || q < 0) {
          result.issues.push(issue3("QUANTITY_INVALID", "$.data.quantity", "quantity 必须是有限非负数或 null（未知）", op));
        } else {
          changes.quantity = q;
          if (q === 0) changes.status = "consumed";
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(data, "properties")) {
      const list = Array.isArray(data.properties) ? data.properties : null;
      if (!list) result.issues.push(issue3("FIELD_TYPE_INVALID", "$.data.properties", "properties 必须是数组", op));
      else if (list.length > ITEM_PROPERTY_LIMIT) result.issues.push(issue3("FIELD_LIMIT_EXCEEDED", "$.data.properties", `properties 最多 ${ITEM_PROPERTY_LIMIT} 项`, op));
      else changes.properties_json = list;
    }
    if (creating && Object.prototype.hasOwnProperty.call(data, "placement")) {
      const placement = data.placement;
      if (isPlainObject3(placement)) {
        if (Object.prototype.hasOwnProperty.call(placement, "holder_ref")) {
          const r = resolveRef(String(placement.holder_ref), "character", ctx.scope, { opId: op.opId, field: "placement.holder_ref" });
          if (r.entry) changes.holder_character_id = r.entry.id;
          else result.issues.push(...r.issues);
        } else if (Object.prototype.hasOwnProperty.call(placement, "container_ref")) {
          const r = resolveRef(String(placement.container_ref), "item", ctx.scope, { opId: op.opId, field: "placement.container_ref" });
          if (r.entry) changes.container_item_id = r.entry.id;
          else result.issues.push(...r.issues);
        } else if (Object.prototype.hasOwnProperty.call(placement, "location_ref")) {
          const r = resolveRef(String(placement.location_ref), "location", ctx.scope, { opId: op.opId, field: "placement.location_ref" });
          if (r.entry) changes.location_id = r.entry.id;
          else result.issues.push(...r.issues);
        } else {
          result.issues.push(issue3("TRANSFER_TARGET_CONFLICT", "$.data.placement", "placement 需要 holder_ref / container_ref / location_ref 之一", op));
        }
      } else {
        result.issues.push(issue3("FIELD_TYPE_INVALID", "$.data.placement", "placement 必须是 {holder_ref|container_ref|location_ref}", op));
      }
    }
    if (result.issues.some((i) => i.severity === "error")) return result;
    if (creating) {
      const row2 = createRow("items", { ...changes }, {
        branchId: ctx.branchId,
        id: rowId,
        turnId: turnIdOf(ctx),
        clockS: ctx.clockS,
        nowWallMs: Date.now(),
        rulesetVersion: "atlas-1"
      });
      result.mutations.push(entityKeyMutation(ctx, op, rowId, "item"));
      result.mutations.push(mutation("items", rowId, null, row2, op, basisFor2(ctx, op)));
      result.entityKeyWrites = [{ id: rowId, kind: "item" }];
    } else {
      const merged = applyPatch(before, changes);
      merged.row_rev = Number(before.row_rev ?? 1) + 1;
      merged.updated_turn_id = turnIdOf(ctx);
      result.mutations.push(mutation("items", rowId, before, merged, op, basisFor2(ctx, op)));
      result.readSet.push(...readSetFor(ctx, "items", rowId));
    }
    result.declaredRefs = ref?.startsWith("new:") ? [declaredRef(ref, rowId, "item", op.opId)] : [];
    return result;
  }
  function compileItemTransfer(op, ctx) {
    const result = emptyCompileResult();
    const data = dataOf(op);
    const ref = op.value.ref?.trim();
    if (!ref) {
      result.issues.push(issue3("MINIMUM_FIELD_MISSING", "$.ref", "item.transfer 需要 ref", op));
      return result;
    }
    const resolved = resolveRef(ref, "item", ctx.scope, { opId: op.opId, line: op.line, field: "ref" });
    if (!resolved.entry) {
      result.issues.push(...resolved.issues);
      return result;
    }
    const rowId = resolved.entry.id;
    const before = ctx.tables.selectOne("items", ctx.branchId, rowId);
    if (!before) {
      result.issues.push(issue3("REF_UNKNOWN", "$.ref", `物品行不存在：${rowId}`, op));
      return result;
    }
    const to = data.to;
    if (!isPlainObject3(to)) {
      result.issues.push(issue3("MINIMUM_FIELD_MISSING", "$.data.to", "item.transfer 需要 to={holder_ref|container_ref|location_ref|unknown}", op));
      return result;
    }
    const kinds = ["holder_ref", "container_ref", "location_ref"].filter(
      (k) => Object.prototype.hasOwnProperty.call(to, k) && to[k] !== null
    );
    const isUnknown = to.unknown === true;
    if (isUnknown && kinds.length > 0) {
      result.issues.push(issue3("TRANSFER_TARGET_CONFLICT", "$.data.to", "to 的落点互斥：unknown 不能与 holder_ref/container_ref/location_ref 同时出现", op));
      return result;
    }
    if (!isUnknown && kinds.length !== 1) {
      result.issues.push(issue3("TRANSFER_TARGET_CONFLICT", "$.data.to", `to 必须且只能给出一种落点（收到 ${kinds.length} 种）`, op));
      return result;
    }
    const changes = {
      holder_character_id: null,
      container_item_id: null,
      location_id: null,
      map_id: null,
      grid_x: null,
      grid_y: null,
      coord_precision: "unknown",
      uncertainty_radius_cells: null
    };
    if (kinds[0] === "holder_ref") {
      const r = resolveRef(String(to.holder_ref), "character", ctx.scope, { opId: op.opId, field: "to.holder_ref" });
      if (!r.entry) {
        result.issues.push(...r.issues);
        return result;
      }
      changes.holder_character_id = r.entry.id;
    } else if (kinds[0] === "container_ref") {
      const r = resolveRef(String(to.container_ref), "item", ctx.scope, { opId: op.opId, field: "to.container_ref" });
      if (!r.entry) {
        result.issues.push(...r.issues);
        return result;
      }
      if (r.entry.id === rowId) {
        result.issues.push(issue3("INVARIANT_CONTAINER_CYCLE", "$.data.to.container_ref", "物品不能装在自己里面", op));
        return result;
      }
      changes.container_item_id = r.entry.id;
    } else if (kinds[0] === "location_ref") {
      const r = resolveRef(String(to.location_ref), "location", ctx.scope, { opId: op.opId, field: "to.location_ref" });
      if (!r.entry) {
        result.issues.push(...r.issues);
        return result;
      }
      changes.location_id = r.entry.id;
      if (isPlainObject3(to.position)) {
        const x = asFiniteNumber(to.position.x);
        const y = asFiniteNumber(to.position.y);
        const mapRef = typeof data.map_ref === "string" ? data.map_ref : null;
        if (x !== null && y !== null && mapRef) {
          const mr = resolveRef(mapRef, "map", ctx.scope, { opId: op.opId, field: "map_ref" });
          if (mr.entry) {
            changes.map_id = mr.entry.id;
            changes.grid_x = x;
            changes.grid_y = y;
            changes.coord_precision = String(to.position.precision ?? "approximate");
          } else {
            result.issues.push(...mr.issues);
          }
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(data, "owner_ref")) {
      if (data.owner_ref === null) {
        changes.owner_entity_id = null;
      } else {
        const r = resolveRef(String(data.owner_ref), ["character", "faction"], ctx.scope, { opId: op.opId, field: "owner_ref" });
        if (!r.entry) {
          result.issues.push(...r.issues);
          return result;
        }
        changes.owner_entity_id = r.entry.id;
      }
    }
    const movedQty = Object.prototype.hasOwnProperty.call(data, "quantity") ? asFiniteNumber(data.quantity) : null;
    const heldQty = typeof before.quantity === "number" ? before.quantity : null;
    if (Object.prototype.hasOwnProperty.call(data, "quantity") && (movedQty === null || movedQty <= 0)) {
      result.issues.push(issue3("QUANTITY_INVALID", "$.data.quantity", "转移数量必须为正有限数", op));
      return result;
    }
    if (movedQty !== null && heldQty !== null && movedQty > heldQty) {
      result.issues.push(issue3("QUANTITY_INSUFFICIENT", "$.data.quantity", `转移数量 ${movedQty} 超过持有量 ${heldQty}`, op));
      return result;
    }
    if (result.issues.some((i) => i.severity === "error")) return result;
    const turnId = turnIdOf(ctx);
    if (movedQty !== null && heldQty !== null && movedQty < heldQty) {
      const remaining = heldQty - movedQty;
      const sourceAfter = applyPatch(before, { quantity: remaining, row_rev: Number(before.row_rev ?? 1) + 1, updated_turn_id: turnId });
      result.mutations.push(mutation("items", rowId, before, sourceAfter, op, basisFor2(ctx, op)));
      const newId = ctx.makeId("item", op.opId, `split:${rowId}:${movedQty}`);
      const newRow = createRow(
        "items",
        { ...before, ...changes, quantity: movedQty },
        { branchId: ctx.branchId, id: newId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: "atlas-1" }
      );
      newRow.row_rev = 1;
      result.mutations.push(entityKeyMutation(ctx, op, newId, "item"));
      result.mutations.push(mutation("items", newId, null, newRow, op, basisFor2(ctx, op)));
      result.entityKeyWrites = [{ id: newId, kind: "item" }];
      result.operationKeys = [{ groupKey: `item:${rowId}`, opKey: `transfer:${op.opId}` }];
      result.readSet.push(...readSetFor(ctx, "items", rowId));
      return result;
    }
    const after = applyPatch(before, { ...changes, row_rev: Number(before.row_rev ?? 1) + 1, updated_turn_id: turnId });
    if (movedQty !== null && heldQty !== null) after.quantity = Math.max(0, heldQty - movedQty);
    if (after.quantity === 0) after.status = "consumed";
    result.mutations.push(mutation("items", rowId, before, after, op, basisFor2(ctx, op)));
    result.operationKeys = [{ groupKey: `item:${rowId}`, opKey: `transfer:${op.opId}` }];
    result.readSet.push(...readSetFor(ctx, "items", rowId));
    return result;
  }
  var FACTION_FIELDS = /* @__PURE__ */ new Set(["name", "aliases", "kind", "description", "goal", "headquarters_ref", "capabilities", "status"]);
  var FACTION_KINDS = ["nation", "organization", "family", "team", "other"];
  var FACTION_STATUS = ["active", "dissolved", "merged", "archived"];
  function compileFactionUpsert(op, ctx) {
    const result = emptyCompileResult();
    const data = dataOf(op);
    const unknown = Object.keys(data).filter((k) => !FACTION_FIELDS.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const ref = op.value.ref?.trim();
    const resolvingExisting = Boolean(ref) && !ref.startsWith("new:");
    const existing = resolvingExisting ? resolveRef(ref, "faction", ctx.scope, { opId: op.opId, line: op.line, field: "ref" }) : null;
    if (resolvingExisting && !existing?.entry) {
      result.issues.push(...existing?.issues ?? [issue3("REF_UNKNOWN", "$.ref", `找不到势力引用：${ref}`, op)]);
      return result;
    }
    const creating = !existing?.entry;
    const name = asString(data.name);
    if (creating && !name) {
      result.issues.push(issue3("MINIMUM_FIELD_MISSING", "$.data.name", "新建势力必须给 name", op));
      return result;
    }
    const rowId = existing?.entry ? existing.entry.id : ctx.makeId("faction", op.opId, ref && ref.startsWith("new:") ? ref.slice(4) : `auto:${op.opId}`);
    const before = existing?.entry ? ctx.tables.selectOne("factions", ctx.branchId, rowId) : null;
    if (!creating && !before) {
      result.issues.push(issue3("REF_UNKNOWN", "$.ref", `引用存在但势力行不存在：${rowId}`, op));
      return result;
    }
    const changes = {};
    if (creating) changes.name = name;
    else if (Object.prototype.hasOwnProperty.call(data, "name")) changes.name = name;
    const aliases = ensureAliases(data.aliases, op, "$.data.aliases");
    result.issues.push(...aliases.issues);
    if (aliases.value) changes.aliases_json = aliases.value;
    if (Object.prototype.hasOwnProperty.call(data, "kind")) {
      const kind = String(data.kind);
      if (!FACTION_KINDS.includes(kind)) result.issues.push(issue3("ENUM_INVALID", "$.data.kind", `势力类型非法：${kind}`, op));
      else changes.kind = kind;
    }
    if (Object.prototype.hasOwnProperty.call(data, "status")) {
      const st = String(data.status);
      if (!FACTION_STATUS.includes(st)) result.issues.push(issue3("ENUM_INVALID", "$.data.status", `势力状态非法：${st}`, op));
      else changes.status = st;
    }
    if (Object.prototype.hasOwnProperty.call(data, "description")) changes.description = String(data.description ?? "");
    if (Object.prototype.hasOwnProperty.call(data, "goal")) changes.goal = String(data.goal ?? "");
    if (Object.prototype.hasOwnProperty.call(data, "capabilities")) {
      const list = Array.isArray(data.capabilities) ? data.capabilities : null;
      if (!list) result.issues.push(issue3("FIELD_TYPE_INVALID", "$.data.capabilities", "capabilities 必须是数组", op));
      else if (list.length > CAPABILITY_LIMIT) result.issues.push(issue3("FIELD_LIMIT_EXCEEDED", "$.data.capabilities", `最多 ${CAPABILITY_LIMIT} 项能力`, op));
      else changes.capabilities_json = list;
    }
    ensureLocationRef(data, "headquarters_ref", op, result.issues, changes, "headquarters_location_id", ["location"], ctx.scope);
    if (result.issues.some((i) => i.severity === "error")) return result;
    const turnId = turnIdOf(ctx);
    if (creating) {
      const row2 = createRow("factions", { ...changes }, {
        branchId: ctx.branchId,
        id: rowId,
        turnId,
        clockS: ctx.clockS,
        nowWallMs: Date.now(),
        rulesetVersion: "atlas-1"
      });
      result.mutations.push(entityKeyMutation(ctx, op, rowId, "faction"));
      result.mutations.push(mutation("factions", rowId, null, row2, op, basisFor2(ctx, op)));
      result.entityKeyWrites = [{ id: rowId, kind: "faction" }];
    } else {
      const merged = applyPatch(before, changes);
      merged.row_rev = Number(before.row_rev ?? 1) + 1;
      merged.updated_turn_id = turnId;
      result.mutations.push(mutation("factions", rowId, before, merged, op, basisFor2(ctx, op)));
      result.readSet.push(...readSetFor(ctx, "factions", rowId));
    }
    result.declaredRefs = ref?.startsWith("new:") ? [declaredRef(ref, rowId, "faction", op.opId)] : [];
    return result;
  }

  // src/atlas-ops-relations.ts
  var RELATION_FIELDS = /* @__PURE__ */ new Set([
    "subject_ref",
    "object_ref",
    "kind",
    "label",
    "attitude",
    "trust",
    "description",
    "secrecy",
    "ends_after_s"
  ]);
  var RELATION_KINDS = ["member_of", "leads", "controls", "knows", "kinship", "ally", "hostile", "owes", "protects", "other"];
  var RELATION_ATTITUDE = ["supportive", "neutral", "suspicious", "hostile", "unknown"];
  var RELATION_TRUST = ["high", "medium", "low", "unknown"];
  var RELATION_SECRECY = ["public", "restricted", "secret"];
  function issue4(code, path, message, op, extra = {}) {
    return { code, path, message, severity: "error", retryable: true, opId: op.opId, line: op.line, ...extra };
  }
  function basisOf(ctx, op) {
    if (ctx.basisFor) return ctx.basisFor(op);
    return {
      kind: ctx.phase === "observe" ? "story" : "simulation",
      sources: [],
      causes: [],
      reason: op.value.why ?? "关系语义操作",
      verification: ctx.phase === "observe" ? "source_bound" : "causal",
      certainty: ctx.phase === "observe" ? "confirmed" : "inferred"
    };
  }
  function compileRelationUpsert(op, ctx) {
    const result = emptyCompileResult();
    const data = op.value.data ?? {};
    const unknown = Object.keys(data).filter((k) => !RELATION_FIELDS.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const ref = op.value.ref?.trim();
    let subjectId = null;
    let objectId = null;
    let existingRow = null;
    let rowId;
    if (ref && !ref.startsWith("new:")) {
      const r = resolveRef(ref, "relation", ctx.scope, { opId: op.opId, line: op.line, field: "ref" });
      if (!r.entry) {
        result.issues.push(...r.issues);
        return result;
      }
      rowId = r.entry.id;
      existingRow = ctx.tables.selectOne("relations", ctx.branchId, rowId);
      if (!existingRow) {
        result.issues.push(issue4("REF_UNKNOWN", "$.ref", `关系引用存在但行不存在：${rowId}`, op));
        return result;
      }
      subjectId = String(existingRow.subject_entity_id);
      objectId = String(existingRow.object_entity_id);
    } else {
      const subject = resolveRef(String(data.subject_ref ?? ""), null, ctx.scope, { opId: op.opId, field: "subject_ref" });
      if (!subject.entry) {
        result.issues.push(...subject.issues.length ? subject.issues : [issue4("MINIMUM_FIELD_MISSING", "$.data.subject_ref", "relation.upsert 需要 subject_ref", op)]);
        return result;
      }
      const object = resolveRef(String(data.object_ref ?? ""), null, ctx.scope, { opId: op.opId, field: "object_ref" });
      if (!object.entry) {
        result.issues.push(...object.issues.length ? object.issues : [issue4("MINIMUM_FIELD_MISSING", "$.data.object_ref", "relation.upsert 需要 object_ref", op)]);
        return result;
      }
      subjectId = subject.entry.id;
      objectId = object.entry.id;
      if (subjectId === objectId) {
        result.issues.push(issue4("RELATION_SELF_TARGET", "$.data.object_ref", "关系的主体和客体不能是同一条身份", op));
        return result;
      }
      const kind = data.kind === void 0 ? "other" : String(data.kind);
      const label = asString(data.label) ?? "";
      const found = ctx.tables.selectWhere(
        "relations",
        { branch_id: ctx.branchId, subject_entity_id: subjectId, object_entity_id: objectId, kind, label },
        1
      );
      existingRow = found.length ? found[0] : null;
      rowId = existingRow ? String(existingRow.id) : ctx.makeId("relation", op.opId, ref ?? `rel:${subjectId}:${objectId}:${kind}:${label}`);
    }
    const changes = {};
    if (Object.prototype.hasOwnProperty.call(data, "kind")) {
      const kind = String(data.kind);
      if (!RELATION_KINDS.includes(kind)) result.issues.push(issue4("ENUM_INVALID", "$.data.kind", `关系类型非法：${kind}`, op));
      else changes.kind = kind;
    }
    if (Object.prototype.hasOwnProperty.call(data, "label")) changes.label = asString(data.label) ?? "";
    if (Object.prototype.hasOwnProperty.call(data, "attitude")) {
      const attitude = String(data.attitude);
      if (!RELATION_ATTITUDE.includes(attitude)) result.issues.push(issue4("ENUM_INVALID", "$.data.attitude", `attitude 非法：${attitude}`, op));
      else changes.attitude = attitude;
    }
    if (Object.prototype.hasOwnProperty.call(data, "trust")) {
      const trust = String(data.trust);
      if (!RELATION_TRUST.includes(trust)) result.issues.push(issue4("ENUM_INVALID", "$.data.trust", `trust 非法：${trust}`, op));
      else changes.trust = trust;
    }
    if (Object.prototype.hasOwnProperty.call(data, "description")) changes.description = String(data.description ?? "");
    if (Object.prototype.hasOwnProperty.call(data, "secrecy")) {
      const secrecy = String(data.secrecy);
      if (!RELATION_SECRECY.includes(secrecy)) result.issues.push(issue4("ENUM_INVALID", "$.data.secrecy", `secrecy 非法：${secrecy}`, op));
      else changes.secrecy = secrecy;
    }
    if (Object.prototype.hasOwnProperty.call(data, "ends_after_s")) {
      const ends = data.ends_after_s;
      if (ends === null) {
        changes.valid_until_s = null;
        changes.status = "active";
      } else if (typeof ends === "number" && Number.isFinite(ends)) {
        changes.valid_until_s = ctx.clockS + ends;
      } else {
        result.issues.push(issue4("FIELD_TYPE_INVALID", "$.data.ends_after_s", "ends_after_s 必须是有限秒数或 null", op));
      }
    }
    if (result.issues.some((i) => i.severity === "error")) return result;
    const turnId = ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
    if (existingRow) {
      const merged = { ...existingRow, ...changes };
      merged.row_rev = Number(existingRow.row_rev ?? 1) + 1;
      merged.updated_turn_id = turnId;
      result.mutations.push({
        table: "relations",
        rowId,
        before: existingRow,
        after: merged,
        sourceOpIds: [op.opId],
        basis: basisOf(ctx, op)
      });
      result.readSet.push({ table: "relations", rowId, rowRev: Number(existingRow.row_rev ?? 1) });
    } else {
      const row2 = createRow(
        "relations",
        { subject_entity_id: subjectId, object_entity_id: objectId, basis_quality: ctx.phase === "observe" ? "confirmed" : "inferred", ...changes },
        { branchId: ctx.branchId, id: rowId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: "atlas-1" }
      );
      result.mutations.push({ table: "relations", rowId, before: null, after: row2, sourceOpIds: [op.opId], basis: basisOf(ctx, op) });
    }
    return result;
  }

  // src/atlas-ops-actions.ts
  var STEP_KINDS = ["prepare", "travel", "wait", "interact", "transmit", "investigate", "act"];
  var ACTION_SECRECY = ["public", "restricted", "secret"];
  function issue5(code, path, message, op, extra = {}) {
    return { code, path, message, severity: "error", retryable: true, opId: op.opId, line: op.line, ...extra };
  }
  function basisOf2(ctx, op, causes = []) {
    if (ctx.basisFor) return ctx.basisFor(op, { causes, certainty: "inferred" });
    return {
      kind: "simulation",
      sources: [],
      causes,
      reason: op.value.why ?? "计划语义操作",
      verification: "causal",
      certainty: "inferred"
    };
  }
  function isPlainObject4(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function mutation2(table, rowId, before, after, op, basis) {
    return { table, rowId, before, after, sourceOpIds: [op.opId], basis };
  }
  function normalizeSteps(steps, op, ctx, issues) {
    if (!Array.isArray(steps) || steps.length === 0) {
      issues.push(issue5("MINIMUM_FIELD_MISSING", "$.data.steps", "plan.propose 需要至少一个 step", op));
      return [];
    }
    const out = [];
    steps.forEach((raw, i) => {
      if (!isPlainObject4(raw)) {
        issues.push(issue5("FIELD_TYPE_INVALID", `$.data.steps[${i}]`, "step 必须是对象", op));
        return;
      }
      const kind = String(raw.kind ?? "");
      if (!STEP_KINDS.includes(kind)) {
        issues.push(issue5("ENUM_INVALID", `$.data.steps[${i}].kind`, `step.kind 非法：${kind}`, op));
        return;
      }
      const payload = {};
      let targetLocationId = null;
      let targetEntityId = null;
      let targetEventId = null;
      let conditionUncompiled = null;
      const dependsOnIndexes = [];
      const resolveOne = (value, kinds, field) => {
        if (typeof value !== "string" || value.trim() === "") return null;
        const r = resolveRef(value, kinds, ctx.scope, { opId: op.opId, field });
        if (!r.entry) {
          issues.push(...r.issues);
          return null;
        }
        return r.entry.id;
      };
      if (kind === "travel") {
        const destination = resolveOne(raw.destination_ref, ["location"], `steps[${i}].destination_ref`);
        if (!destination) {
          issues.push(issue5("MINIMUM_FIELD_MISSING", `$.data.steps[${i}].destination_ref`, "travel step 需要 destination_ref", op));
          return;
        }
        targetLocationId = destination;
        const via = [];
        if (Array.isArray(raw.via_refs)) {
          for (const v of raw.via_refs.slice(0, ACTION_PAYLOAD_REF_LIMIT)) {
            const id = resolveOne(v, ["location"], `steps[${i}].via_refs`);
            if (id) via.push(id);
          }
        }
        payload.destination_ref = destination;
        payload.via_refs = via;
        payload.mobility_key = typeof raw.mobility_key === "string" ? raw.mobility_key : null;
        const stopPolicy = raw.stop_policy === void 0 ? "review" : String(raw.stop_policy);
        payload.stop_policy = ["continue", "review", "stop"].includes(stopPolicy) ? stopPolicy : "review";
      } else if (kind === "wait") {
        const eventId = resolveOne(raw.wait_for_event_ref, ["event"], `steps[${i}].wait_for_event_ref`);
        if (eventId) {
          payload.until = { event_status: { event_ref: eventId, status: String(raw.wait_for_status ?? "occurred") } };
          targetEventId = eventId;
        } else if (typeof raw.wait_for_status === "string" && raw.wait_for_status.trim() !== "") {
          conditionUncompiled = raw.wait_for_status;
        } else {
          issues.push(
            issue5("MINIMUM_FIELD_MISSING", `$.data.steps[${i}]`, "wait step 需要 wait_for_event_ref 或明确条件；时间未知的典礼不要编一个具体时刻", op)
          );
          return;
        }
      } else if (kind === "transmit") {
        const informationId = resolveOne(raw.information_ref, ["information"], `steps[${i}].information_ref`);
        const channelId = resolveOne(raw.channel_ref, ["channel"], `steps[${i}].channel_ref`);
        const recipient = resolveOne(raw.recipient_ref, ["character", "faction", "location"], `steps[${i}].recipient_ref`);
        if (!informationId || !recipient) {
          issues.push(issue5("MINIMUM_FIELD_MISSING", `$.data.steps[${i}]`, "transmit step 需要 information_ref 与 recipient_ref", op));
          return;
        }
        payload.information_ref = informationId;
        payload.channel_ref = channelId;
        payload.recipient = recipient;
        targetEntityId = recipient;
      } else if (kind === "interact") {
        const other = resolveOne(raw.target_ref, null, `steps[${i}].target_ref`);
        if (!other) {
          issues.push(issue5("MINIMUM_FIELD_MISSING", `$.data.steps[${i}].target_ref`, "interact step 需要 target_ref", op));
          return;
        }
        payload.other_ref = other;
        payload.purpose = typeof raw.purpose === "string" ? raw.purpose : typeof raw.method === "string" ? raw.method : "";
        targetEntityId = other;
      } else if (kind === "investigate") {
        const subject = resolveOne(raw.target_ref, null, `steps[${i}].target_ref`);
        const informationId = resolveOne(raw.information_ref, ["information"], `steps[${i}].information_ref`);
        payload.subject_ref = subject;
        payload.information_ref = informationId;
        payload.method = typeof raw.method === "string" ? raw.method : "";
        targetEntityId = subject;
      } else if (kind === "prepare") {
        payload.method = typeof raw.method === "string" ? raw.method : "";
        payload.capability_key = typeof raw.capability_key === "string" ? raw.capability_key : null;
        payload.item_refs = [];
        if (Array.isArray(raw.item_refs)) {
          for (const v of raw.item_refs.slice(0, ACTION_PAYLOAD_REF_LIMIT)) {
            const id = resolveOne(v, ["item"], `steps[${i}].item_refs`);
            if (id) payload.item_refs.push(id);
          }
        }
      } else if (kind === "act") {
        payload.method = typeof raw.method === "string" ? raw.method : "";
        payload.capability_key = typeof raw.capability_key === "string" ? raw.capability_key : null;
        const stakes = raw.stakes === void 0 ? "ordinary" : String(raw.stakes);
        if (!["ordinary", "major"].includes(stakes)) {
          issues.push(issue5("ENUM_INVALID", `$.data.steps[${i}].stakes`, `stakes 非法：${stakes}`, op));
          return;
        }
        payload.stakes = stakes;
        const policy = raw.outcome_policy === void 0 ? "model_with_checks" : String(raw.outcome_policy);
        payload.outcome_policy = ["rules", "model_with_checks"].includes(policy) ? policy : "model_with_checks";
      }
      let durationHint = null;
      if (isPlainObject4(raw.duration_hint)) {
        const hint = raw.duration_hint;
        const min = typeof hint.min_s === "number" ? hint.min_s : null;
        const nominal = typeof hint.nominal_s === "number" ? hint.nominal_s : null;
        const max = typeof hint.max_s === "number" ? hint.max_s : null;
        if (min !== null && nominal !== null && max !== null && min >= 0 && min <= nominal && nominal <= max) {
          durationHint = { min_s: min, nominal_s: nominal, max_s: max, quality: "estimated", basis_refs: [] };
        } else if (min !== null || nominal !== null || max !== null) {
          issues.push(issue5("DURATION_ORDER_INVALID", `$.data.steps[${i}].duration_hint`, "duration_hint 必须 0≤min≤nominal≤max", op));
        }
      }
      if (typeof raw.requires_action_ref === "string" && raw.requires_action_ref.trim() !== "") {
        const idx = Number(raw.requires_action_ref);
        if (Number.isInteger(idx) && idx >= 0 && idx < i) dependsOnIndexes.push(idx);
      }
      out.push({
        kind,
        title: typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title : kind,
        intent: typeof raw.method === "string" && kind !== "travel" ? raw.method : "",
        payload,
        targetLocationId,
        targetEntityId,
        targetEventId,
        conditionUncompiled,
        durationHint,
        dependsOnIndexes
      });
    });
    return out;
  }
  function compilePlanPropose(op, ctx) {
    const result = emptyCompileResult();
    const data = op.value.data ?? {};
    const known = /* @__PURE__ */ new Set([
      "actor_ref",
      "goal",
      "steps",
      "target_ref",
      "target_location_ref",
      "target_event_ref",
      "secrecy"
    ]);
    const unknown = Object.keys(data).filter((k) => !known.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const actor = resolveRef(String(data.actor_ref ?? ""), null, ctx.scope, { opId: op.opId, line: op.line, field: "actor_ref" });
    if (!actor.entry) {
      result.issues.push(
        ...actor.issues.length ? actor.issues : [issue5("MINIMUM_FIELD_MISSING", "$.data.actor_ref", "plan.propose 需要 actor_ref", op)]
      );
      return result;
    }
    const goal = asString(data.goal);
    if (!goal) {
      result.issues.push(issue5("MINIMUM_FIELD_MISSING", "$.data.goal", "plan.propose 需要 goal", op));
      return result;
    }
    const steps = normalizeSteps(data.steps, op, ctx, result.issues);
    if (result.issues.some((i) => i.severity === "error")) return result;
    let secrecy = "restricted";
    if (data.secrecy !== void 0) {
      const s = String(data.secrecy);
      if (!ACTION_SECRECY.includes(s)) {
        result.issues.push(issue5("ENUM_INVALID", "$.data.secrecy", `secrecy 非法：${s}`, op));
        return result;
      }
      secrecy = s;
    }
    const turnId = ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
    const actorId = actor.entry.id;
    const planId = ctx.makeId("action", op.opId, `plan:${goal}`);
    const parentRow = createRow(
      "actions",
      {
        actor_entity_id: actorId,
        parent_action_id: null,
        kind: "goal",
        title: goal.slice(0, 80),
        intent: goal,
        secrecy,
        status: "planned"
      },
      { branchId: ctx.branchId, id: planId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: "atlas-1" }
    );
    result.mutations.push(mutation2("actions", planId, null, parentRow, op, basisOf2(ctx, op)));
    const stepIds = [];
    steps.forEach((step, index) => {
      const stepId = ctx.makeId("action", op.opId, `step:${index}:${step.kind}`);
      stepIds.push(stepId);
    });
    steps.forEach((step, index) => {
      const stepId = stepIds[index];
      const dependsOn = step.dependsOnIndexes.map((i) => stepIds[i]).filter(Boolean).slice(0, ACTION_DEPENDS_LIMIT);
      const row2 = createRow(
        "actions",
        {
          actor_entity_id: actorId,
          parent_action_id: planId,
          kind: step.kind,
          title: step.title.slice(0, 80),
          intent: step.conditionUncompiled ?? step.intent,
          target_entity_id: step.targetEntityId,
          target_location_id: step.targetLocationId,
          target_event_id: step.targetEventId,
          depends_on_json: dependsOn,
          payload_json: step.payload,
          duration_json: step.durationHint,
          secrecy,
          // §8.4：无法解析的自然语言条件保留在 intent，行动标记 blocked，不假装条件已满足。
          status: step.conditionUncompiled ? "blocked" : "planned",
          reason_code: step.conditionUncompiled ? "CONDITION_UNCOMPILED" : null
        },
        { branchId: ctx.branchId, id: stepId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: "atlas-1" }
      );
      result.mutations.push(mutation2("actions", stepId, null, row2, op, basisOf2(ctx, op)));
      if (step.conditionUncompiled) {
        result.issues.push({
          code: "CONDITION_UNCOMPILED",
          path: `$.data.steps[${index}]`,
          message: `条件「${step.conditionUncompiled}」无法编译为确定条件树：保留在 intent，行动标记 blocked，不假装已满足`,
          severity: "warning",
          retryable: false,
          opId: op.opId,
          line: op.line
        });
      }
    });
    for (let i = 1; i < stepIds.length; i += 1) result.dependencies.push(stepIds[0]);
    result.effects = [{ kind: "plan_created", planId, stepIds }];
    return result;
  }
  function compilePlanRevise(op, ctx) {
    const result = emptyCompileResult();
    const data = op.value.data ?? {};
    const known = /* @__PURE__ */ new Set(["ref", "change", "steps", "destination_ref", "why"]);
    const unknown = Object.keys(data).filter((k) => !known.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const ref = (op.value.ref ?? asString(data.ref))?.trim();
    if (!ref) {
      result.issues.push(issue5("MINIMUM_FIELD_MISSING", "$.ref", "plan.revise 需要 ref", op));
      return result;
    }
    const change = data.change === void 0 ? "" : String(data.change);
    if (!["pause", "cancel", "resume", "replace_future"].includes(change)) {
      result.issues.push(issue5("MINIMUM_FIELD_MISSING", "$.data.change", "change 必须是 pause/cancel/resume/replace_future", op));
      return result;
    }
    const resolved = resolveRef(ref, "action", ctx.scope, { opId: op.opId, line: op.line, field: "ref" });
    if (!resolved.entry) {
      result.issues.push(...resolved.issues);
      return result;
    }
    const rowId = resolved.entry.id;
    const before = ctx.tables.selectOne("actions", ctx.branchId, rowId);
    if (!before) {
      result.issues.push(issue5("REF_UNKNOWN", "$.ref", `行动引用存在但行不存在：${rowId}`, op));
      return result;
    }
    const turnId = ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
    const touches = [];
    const children = ctx.tables.selectWhere("actions", { branch_id: ctx.branchId, parent_action_id: rowId }, 64).filter(
      (c) => !["completed", "failed", "cancelled"].includes(String(c.status))
    );
    const applyTo = (row2, patch) => {
      const merged = { ...row2, ...patch };
      merged.row_rev = Number(row2.row_rev ?? 1) + 1;
      merged.updated_turn_id = turnId;
      return merged;
    };
    if (change === "pause") {
      if (before.status === "completed" || before.status === "cancelled") {
        result.issues.push(issue5("ACTION_STATE_INVALID", "$.data.change", `已结束的行动（${before.status}）不能暂停`, op));
        return result;
      }
      touches.push({ rowId, row: before, target: applyTo(before, { status: "paused", reason_code: "PLAN_PAUSED" }) });
      for (const c of children) touches.push({ rowId: String(c.id), row: c, target: applyTo(c, { status: "paused", reason_code: "PLAN_PAUSED" }) });
    } else if (change === "resume") {
      if (!["paused", "blocked"].includes(String(before.status))) {
        result.issues.push(issue5("ACTION_STATE_INVALID", "$.data.change", `只有 paused/blocked 的行动可以恢复（当前 ${before.status}）`, op));
        return result;
      }
      touches.push({ rowId, row: before, target: applyTo(before, { status: "planned", reason_code: null }) });
      for (const c of children) {
        if (c.status === "paused") touches.push({ rowId: String(c.id), row: c, target: applyTo(c, { status: "planned", reason_code: null }) });
      }
    } else if (change === "cancel") {
      touches.push({
        rowId,
        row: before,
        target: applyTo(before, { status: "cancelled", finished_at_s: ctx.clockS, reason_code: "PLAN_CANCELLED" })
      });
      for (const c of children) {
        touches.push({ rowId: String(c.id), row: c, target: applyTo(c, { status: "cancelled", finished_at_s: ctx.clockS, reason_code: "PLAN_CANCELLED" }) });
      }
    } else {
      const steps = normalizeSteps(data.steps, op, ctx, result.issues);
      if (result.issues.some((i) => i.severity === "error")) return result;
      if (steps.length === 0) {
        result.issues.push(issue5("MINIMUM_FIELD_MISSING", "$.data.steps", "replace_future 需要新的 steps", op));
        return result;
      }
      for (const c of children) {
        touches.push({ rowId: String(c.id), row: c, target: applyTo(c, { status: "cancelled", reason_code: "PLAN_REPLACED" }) });
      }
      steps.forEach((step, index) => {
        const stepId = ctx.makeId("action", op.opId, `future:${index}:${step.kind}`);
        const row2 = createRow(
          "actions",
          {
            actor_entity_id: String(before.actor_entity_id),
            parent_action_id: rowId,
            kind: step.kind,
            title: step.title.slice(0, 80),
            intent: step.conditionUncompiled ?? step.intent,
            target_entity_id: step.targetEntityId,
            target_location_id: step.targetLocationId,
            target_event_id: step.targetEventId,
            payload_json: step.payload,
            duration_json: step.durationHint,
            secrecy: String(before.secrecy ?? "restricted"),
            status: step.conditionUncompiled ? "blocked" : "planned",
            reason_code: step.conditionUncompiled ? "CONDITION_UNCOMPILED" : null
          },
          { branchId: ctx.branchId, id: stepId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: "atlas-1" }
        );
        result.mutations.push(mutation2("actions", stepId, null, row2, op, basisOf2(ctx, op)));
      });
      if (Object.prototype.hasOwnProperty.call(data, "destination_ref")) {
        const dest = resolveRef(String(data.destination_ref), "location", ctx.scope, { opId: op.opId, field: "destination_ref" });
        if (!dest.entry) result.issues.push(...dest.issues);
        else touches.push({ rowId, row: before, target: applyTo(before, { target_location_id: dest.entry.id }) });
      }
      result.effects = [{ kind: "plan_replaced_future", planId: rowId }];
    }
    if (result.issues.some((i) => i.severity === "error")) return result;
    for (const t of touches) {
      result.mutations.push(mutation2("actions", t.rowId, t.row, t.target, op, basisOf2(ctx, op)));
      result.readSet.push({ table: "actions", rowId: t.rowId, rowRev: Number(t.row.row_rev ?? 1) });
    }
    return result;
  }

  // src/atlas-ops-events.ts
  var EVENT_KINDS = ["ceremony", "conflict", "arrival", "passage", "discovery", "trade", "communication", "incident", "other"];
  var EVENT_PHASES2 = ["scheduled", "observed", "simulated"];
  var SECRECY = ["public", "restricted", "secret"];
  var CHARACTER_STATUS = ["alive", "incapacitated", "dead", "unknown"];
  var LOCATION_STATUS = ["active", "destroyed", "merged", "archived"];
  var ACTION_RESULT = ["completed", "failed", "cancelled"];
  var EFFECT_TYPES = ["character_status", "item_transfer", "location_status", "action_result"];
  function issue6(code, path, message, op, extra = {}) {
    return { code, path, message, severity: "error", retryable: true, opId: op.opId, line: op.line, ...extra };
  }
  function isPlainObject5(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function mutation3(table, rowId, before, after, op, basis) {
    return { table, rowId, before, after, sourceOpIds: [op.opId], basis };
  }
  function timeHintToEstimate(hint, op, issues) {
    if (!isPlainObject5(hint)) return { quality: "unknown", basis_refs: [] };
    const elapsed = typeof hint.elapsed_s === "number" && Number.isFinite(hint.elapsed_s) ? hint.elapsed_s : null;
    const min = typeof hint.min_s === "number" && Number.isFinite(hint.min_s) ? hint.min_s : null;
    const max = typeof hint.max_s === "number" && Number.isFinite(hint.max_s) ? hint.max_s : null;
    if (elapsed !== null && elapsed < 0) {
      issues.push(issue6("DURATION_NEGATIVE", "$.data.time_hint.elapsed_s", "elapsed_s 不能为负", op));
      return { quality: "unknown", basis_refs: [] };
    }
    if (elapsed !== null) {
      return { min_s: min ?? elapsed, nominal_s: elapsed, max_s: max ?? elapsed, quality: "explicit", basis_refs: [] };
    }
    if (min !== null || max !== null) {
      const lo = min ?? 0;
      const hi = max ?? lo;
      if (hi < lo) {
        issues.push(issue6("DURATION_ORDER_INVALID", "$.data.time_hint", "time_hint 需要 min_s ≤ max_s", op));
        return { quality: "unknown", basis_refs: [] };
      }
      return { min_s: lo, nominal_s: Math.round((lo + hi) / 2), max_s: hi, quality: "estimated", basis_refs: [] };
    }
    return { quality: "unknown", basis_refs: [], text: typeof hint.text === "string" ? hint.text : void 0 };
  }
  function compileEventPropose(op, ctx) {
    const result = emptyCompileResult();
    const data = op.value.data ?? {};
    const known = /* @__PURE__ */ new Set([
      "title",
      "phase",
      "kind",
      "location_ref",
      "route_ref",
      "actor_ref",
      "participants",
      "action_ref",
      "event_ref",
      "time_hint",
      "activity",
      "result",
      "effects",
      "secrecy",
      "subject_ref"
    ]);
    const unknown = Object.keys(data).filter((k) => !known.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const title = asString(data.title);
    if (!title) {
      result.issues.push(issue6("MINIMUM_FIELD_MISSING", "$.data.title", "event.propose 需要 title", op));
      return result;
    }
    const phase = data.phase === void 0 ? "" : String(data.phase);
    if (!EVENT_PHASES2.includes(phase)) {
      result.issues.push(issue6("MINIMUM_FIELD_MISSING", "$.data.phase", "event.propose 需要 phase=scheduled/observed/simulated", op));
      return result;
    }
    const resolveOne = (value, kinds, field) => {
      if (typeof value !== "string" || value.trim() === "") return null;
      const r = resolveRef(value, kinds, ctx.scope, { opId: op.opId, field });
      if (!r.entry) {
        result.issues.push(...r.issues);
        return null;
      }
      return r.entry.id;
    };
    const locationId = resolveOne(data.location_ref, ["location"], "location_ref");
    const routeId = resolveOne(data.route_ref, ["route"], "route_ref");
    const subjectId = resolveOne(data.subject_ref, ["character", "faction", "item"], "subject_ref");
    const causeActionId = resolveOne(data.action_ref, ["action"], "action_ref");
    const parentEventId = resolveOne(data.event_ref, ["event"], "event_ref");
    if (phase === "simulated" && !causeActionId) {
      result.issues.push(
        issue6("SIMULATED_EVENT_UNBOUND", "$.data.action_ref", "simulated 事件必须绑定真实到期行动（action_ref）；不能凭标题落实结果", op)
      );
      return result;
    }
    const participants = [];
    if (Array.isArray(data.participants)) {
      for (const raw of data.participants.slice(0, PARTICIPANTS_LIMIT)) {
        if (!isPlainObject5(raw)) continue;
        const refValue = raw.entity_ref ?? raw.ref ?? raw.entity_id;
        const id = resolveOne(refValue, ["character", "faction", "item", "location"], "participants");
        if (!id) continue;
        participants.push({ entity_id: id, role: typeof raw.role === "string" ? raw.role : "participant" });
      }
      if (data.participants.length > PARTICIPANTS_LIMIT) {
        result.issues.push(issue6("FIELD_LIMIT_EXCEEDED", "$.data.participants", `participants 最多 ${PARTICIPANTS_LIMIT} 个`, op));
      }
    }
    let secrecy = "restricted";
    if (data.secrecy !== void 0) {
      const s = String(data.secrecy);
      if (!SECRECY.includes(s)) {
        result.issues.push(issue6("ENUM_INVALID", "$.data.secrecy", `secrecy 非法：${s}`, op));
        return result;
      }
      secrecy = s;
    }
    let kind = "other";
    if (data.kind !== void 0) {
      const k = String(data.kind);
      if (!EVENT_KINDS.includes(k)) {
        result.issues.push(issue6("ENUM_INVALID", "$.data.kind", `事件类型非法：${k}`, op));
        return result;
      }
      kind = k;
    }
    const elapsed = timeHintToEstimate(data.time_hint, op, result.issues);
    const occurredAt = phase === "scheduled" ? null : ctx.clockS;
    const status = phase === "scheduled" ? "scheduled" : "occurred";
    const scheduledStart = phase === "scheduled" ? typeof data.time_hint === "object" && isPlainObject5(data.time_hint) && typeof data.time_hint.at_s === "number" ? data.time_hint.at_s : null : occurredAt;
    const eventId = ctx.makeId("event", op.opId, `event:${title}`);
    const turnId = ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
    const summary = asString(data.result) ?? title;
    const row2 = createRow(
      "events",
      {
        title,
        kind,
        summary,
        location_id: locationId,
        route_id: routeId,
        subject_entity_id: subjectId,
        participants_json: participants,
        cause_action_id: causeActionId,
        parent_event_id: parentEventId,
        scheduled_start_s: scheduledStart,
        occurred_at_s: occurredAt,
        outcome: phase === "scheduled" ? "" : summary,
        secrecy,
        status
      },
      { branchId: ctx.branchId, id: eventId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: "atlas-1" }
    );
    result.mutations.push(mutation3("events", eventId, null, row2, op, basisWith(ctx, op, causeActionId ? [{ kind: "action", id: causeActionId }] : [])));
    result.effects = [{ kind: "event_time_estimate", eventId, elapsed, phase }];
    const effects = data.effects;
    if (effects !== void 0) {
      if (!Array.isArray(effects)) {
        result.issues.push(issue6("FIELD_TYPE_INVALID", "$.data.effects", "effects 必须是数组", op));
        return result;
      }
      for (let i = 0; i < effects.length; i += 1) {
        const eff = effects[i];
        if (!isPlainObject5(eff)) {
          result.issues.push(issue6("FIELD_TYPE_INVALID", `$.data.effects[${i}]`, "effect 必须是对象", op));
          continue;
        }
        const type = String(eff.type ?? "");
        if (!EFFECT_TYPES.includes(type)) {
          result.issues.push(issue6("EFFECT_TYPE_UNSUPPORTED", `$.data.effects[${i}].type`, `不允许的事件效果类型：${type}`, op));
          continue;
        }
        if (type === "character_status") {
          const targetId = resolveOne(eff.target_ref, ["character"], `effects[${i}].target_ref`);
          if (!targetId) continue;
          const value = String(eff.value ?? "");
          if (!CHARACTER_STATUS.includes(value)) {
            result.issues.push(issue6("ENUM_INVALID", `$.data.effects[${i}].value`, `character_status 取值非法：${value}`, op));
            continue;
          }
          const before = ctx.tables.selectOne("characters", ctx.branchId, targetId);
          if (!before) {
            result.issues.push(issue6("REF_UNKNOWN", `$.data.effects[${i}].target_ref`, `人物不存在：${targetId}`, op));
            continue;
          }
          const after = applyPatch(before, {
            physical_status: value,
            row_rev: Number(before.row_rev ?? 1) + 1,
            updated_turn_id: turnId
          });
          result.mutations.push(mutation3("characters", targetId, before, after, op, basisWith(ctx, op, [{ kind: "event", id: eventId }])));
          result.readSet.push({ table: "characters", rowId: targetId, rowRev: Number(before.row_rev ?? 1) });
          if (value === "dead" || value === "incapacitated") {
            result.effects.push({ kind: "halt_actor_work", entityId: targetId, reasonCode: value === "dead" ? "ACTOR_DEAD" : "ACTOR_INCAPACITATED" });
          }
        } else if (type === "location_status") {
          const targetId = resolveOne(eff.target_ref, ["location"], `effects[${i}].target_ref`);
          if (!targetId) continue;
          const value = String(eff.value ?? "");
          if (!LOCATION_STATUS.includes(value)) {
            result.issues.push(issue6("ENUM_INVALID", `$.data.effects[${i}].value`, `location_status 取值非法：${value}`, op));
            continue;
          }
          const before = ctx.tables.selectOne("locations", ctx.branchId, targetId);
          if (!before) {
            result.issues.push(issue6("REF_UNKNOWN", `$.data.effects[${i}].target_ref`, `地点不存在：${targetId}`, op));
            continue;
          }
          const after = applyPatch(before, { status: value, row_rev: Number(before.row_rev ?? 1) + 1, updated_turn_id: turnId });
          result.mutations.push(mutation3("locations", targetId, before, after, op, basisWith(ctx, op, [{ kind: "event", id: eventId }])));
          result.readSet.push({ table: "locations", rowId: targetId, rowRev: Number(before.row_rev ?? 1) });
        } else if (type === "action_result") {
          const actionId = resolveOne(eff.action_ref, ["action"], `effects[${i}].action_ref`);
          if (!actionId) continue;
          const value = String(eff.value ?? "");
          if (!ACTION_RESULT.includes(value)) {
            result.issues.push(issue6("ENUM_INVALID", `$.data.effects[${i}].value`, `action_result 取值非法：${value}`, op));
            continue;
          }
          const before = ctx.tables.selectOne("actions", ctx.branchId, actionId);
          if (!before) {
            result.issues.push(issue6("REF_UNKNOWN", `$.data.effects[${i}].action_ref`, `行动不存在：${actionId}`, op));
            continue;
          }
          const after = applyPatch(before, {
            status: value,
            finished_at_s: ctx.clockS,
            result_event_id: eventId,
            row_rev: Number(before.row_rev ?? 1) + 1,
            updated_turn_id: turnId
          });
          result.mutations.push(mutation3("actions", actionId, before, after, op, basisWith(ctx, op, [{ kind: "event", id: eventId }])));
          result.readSet.push({ table: "actions", rowId: actionId, rowRev: Number(before.row_rev ?? 1) });
        } else if (type === "item_transfer") {
          const itemRef = eff.item_ref;
          const synthetic = {
            opId: op.opId,
            line: op.line,
            rawHash: op.rawHash,
            value: {
              op: "item.transfer",
              ref: typeof itemRef === "string" ? itemRef : void 0,
              data: { to: eff.to, quantity: eff.quantity },
              why: op.value.why
            }
          };
          const transfer = compileItemTransfer(synthetic, ctx);
          result.issues.push(...transfer.issues.map((i2) => ({ ...i2, path: `$.data.effects[${i2}].${i2.path.replace(/^\$\./, "")}` })));
          result.mutations.push(...transfer.mutations);
          result.readSet.push(...transfer.readSet);
          if (transfer.entityKeyWrites) result.entityKeyWrites = [...result.entityKeyWrites ?? [], ...transfer.entityKeyWrites];
        }
      }
    }
    result.declaredRefs = [];
    if (result.issues.some((i) => i.severity === "error")) return result;
    return result;
  }
  function basisWith(ctx, op, causes) {
    if (ctx.basisFor) return ctx.basisFor(op, { causes, certainty: "inferred" });
    return {
      kind: op.value.op === "event.propose" && ctx.phase === "observe" ? "story" : "simulation",
      sources: [],
      causes,
      reason: op.value.why ?? "事件语义操作",
      verification: "causal",
      certainty: "inferred"
    };
  }

  // src/atlas-ops-information.ts
  var INFORMATION_KINDS = ["observation", "report", "rumor", "announcement", "lie", "hypothesis"];
  var TRUTH_STATUS = ["true", "false", "mixed", "unknown"];
  var SECRECY2 = ["public", "restricted", "secret"];
  var BELIEF = ["heard", "doubted", "believed", "verified", "rejected"];
  var ATTENTION = ["low", "normal", "high"];
  var CHANNEL_KINDS = ["contact", "faction_network", "messenger", "surveillance", "broadcast", "magic", "other"];
  var RELIABILITY = ["high", "medium", "low", "unknown"];
  function issue7(code, path, message, op, extra = {}) {
    return { code, path, message, severity: "error", retryable: true, opId: op.opId, line: op.line, ...extra };
  }
  function isPlainObject6(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function mutation4(table, rowId, before, after, op, basis) {
    return { table, rowId, before, after, sourceOpIds: [op.opId], basis };
  }
  function basisOf3(ctx, op, causes = []) {
    if (ctx.basisFor) return ctx.basisFor(op, { causes, certainty: "inferred" });
    return {
      kind: ctx.phase === "observe" ? "story" : "simulation",
      sources: [],
      causes,
      reason: op.value.why ?? "信息语义操作",
      verification: ctx.phase === "observe" ? "source_bound" : "causal",
      certainty: ctx.phase === "observe" ? "confirmed" : "inferred"
    };
  }
  function contentHashOf(content) {
    let h1 = 2166136261;
    let h2 = 16777619;
    for (let i = 0; i < content.length; i += 1) {
      const c = content.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = (Math.imul(h2 ^ c, 2246822507) >>> 0) + c;
    }
    return `${h1.toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
  }
  function topicKeyOf(kind, subjectId, content) {
    const subject = subjectId ?? "none";
    return `${kind}:${subject}:${contentHashOf(content.slice(0, 120))}`;
  }
  function compileInformationPropose(op, ctx) {
    const result = emptyCompileResult();
    const data = op.value.data ?? {};
    const known = /* @__PURE__ */ new Set([
      "title",
      "content",
      "kind",
      "event_ref",
      "subject_ref",
      "origin_ref",
      "originator_ref",
      "parent_ref",
      "truth",
      "secrecy",
      "spread_at_ref",
      "recipient_ref",
      "payload"
    ]);
    const unknown = Object.keys(data).filter((k) => !known.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const content = asString(data.content);
    if (!content) {
      result.issues.push(issue7("MINIMUM_FIELD_MISSING", "$.data.content", "information.propose 需要 content", op));
      return result;
    }
    const resolveOne = (value, kinds, field) => {
      if (typeof value !== "string" || value.trim() === "") return null;
      const r = resolveRef(value, kinds, ctx.scope, { opId: op.opId, field });
      if (!r.entry) {
        result.issues.push(...r.issues);
        return null;
      }
      return r.entry.id;
    };
    let kind = "observation";
    if (data.kind !== void 0) {
      const k = String(data.kind);
      if (!INFORMATION_KINDS.includes(k)) {
        result.issues.push(issue7("ENUM_INVALID", "$.data.kind", `信息性质非法：${k}`, op));
        return result;
      }
      kind = k;
    }
    let truth = "unknown";
    if (data.truth !== void 0) {
      const t = String(data.truth);
      if (!TRUTH_STATUS.includes(t)) {
        result.issues.push(issue7("ENUM_INVALID", "$.data.truth", `truth 非法：${t}`, op));
        return result;
      }
      truth = t;
    }
    let secrecy = "restricted";
    if (data.secrecy !== void 0) {
      const s = String(data.secrecy);
      if (!SECRECY2.includes(s)) {
        result.issues.push(issue7("ENUM_INVALID", "$.data.secrecy", `secrecy 非法：${s}`, op));
        return result;
      }
      secrecy = s;
    }
    const subjectId = resolveOne(data.subject_ref, ["character", "faction", "item", "location"], "subject_ref");
    const eventId = resolveOne(data.event_ref, ["event"], "event_ref");
    const originLocationId = resolveOne(data.origin_ref, ["location"], "origin_ref");
    const originatorId = resolveOne(data.originator_ref, ["character", "faction"], "originator_ref");
    const parentId = resolveOne(data.parent_ref, ["information"], "parent_ref");
    const spreadAtLocationId = resolveOne(data.spread_at_ref, ["location"], "spread_at_ref");
    const recipientId = resolveOne(data.recipient_ref, ["character", "faction"], "recipient_ref");
    if (data.payload !== void 0 && data.payload !== null && !isPlainObject6(data.payload)) {
      result.issues.push(issue7("FIELD_TYPE_INVALID", "$.data.payload", "payload 必须是 SubjectPayload 对象", op));
      return result;
    }
    const hash = contentHashOf(content);
    const topicKey = topicKeyOf(kind, subjectId, content);
    const duplicate = ctx.tables.selectOne("information", ctx.branchId, ctx.makeId("information", op.opId, `info:${topicKey}:${hash}`));
    const infoId = ctx.makeId("information", op.opId, `info:${topicKey}:${hash}`);
    const turnId = ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
    if (duplicate) {
      result.effects = [{ kind: "information_reused", informationId: infoId, spreadAtLocationId, recipientId }];
      result.mutations.push(
        mutation4(
          "information",
          infoId,
          duplicate,
          applyPatch(duplicate, { row_rev: Number(duplicate.row_rev ?? 1) + 1, updated_turn_id: turnId }),
          op,
          basisOf3(ctx, op)
        )
      );
      result.readSet.push({ table: "information", rowId: infoId, rowRev: Number(duplicate.row_rev ?? 1) });
    } else {
      const row2 = createRow(
        "information",
        {
          kind,
          title: asString(data.title) ?? content.slice(0, 40),
          content,
          source_event_id: eventId,
          subject_entity_id: subjectId,
          payload_json: data.payload ?? null,
          origin_location_id: originLocationId,
          originator_entity_id: originatorId,
          parent_information_id: parentId,
          truth_status: truth,
          secrecy,
          topic_key: topicKey,
          content_hash: hash,
          created_at_s: ctx.clockS
        },
        { branchId: ctx.branchId, id: infoId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: "atlas-1" }
      );
      result.mutations.push(mutation4("information", infoId, null, row2, op, basisOf3(ctx, op)));
      result.effects = [{ kind: "information_created", informationId: infoId, spreadAtLocationId, recipientId }];
    }
    if (spreadAtLocationId) {
      const frontId = ctx.makeId("rumor_front", op.opId, `front:${infoId}:${spreadAtLocationId}`);
      const existingFront = ctx.tables.selectOne("rumor_fronts", ctx.branchId, frontId);
      if (existingFront) {
        result.mutations.push(
          mutation4(
            "rumor_fronts",
            frontId,
            existingFront,
            applyPatch(existingFront, { last_reinforced_at_s: ctx.clockS, row_rev: Number(existingFront.row_rev ?? 1) + 1, updated_turn_id: turnId }),
            op,
            basisOf3(ctx, op)
          )
        );
      } else {
        const front = createRow(
          "rumor_fronts",
          {
            information_id: infoId,
            location_id: spreadAtLocationId,
            first_available_at_s: ctx.clockS,
            last_reinforced_at_s: ctx.clockS,
            next_spread_check_s: ctx.clockS + 3600,
            reach: "local",
            audience_json: { access: "public", tags: [] },
            status: "active"
          },
          { branchId: ctx.branchId, id: frontId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: "atlas-1" }
        );
        result.mutations.push(mutation4("rumor_fronts", frontId, null, front, op, basisOf3(ctx, op)));
      }
      result.effects.push({ kind: "front_available", informationId: infoId, locationId: spreadAtLocationId, frontId });
    }
    if (recipientId) {
      const knowledgeId = ctx.makeId("knowledge", op.opId, `know:${infoId}:${recipientId}`);
      const existingKnowledge = ctx.tables.selectOne("knowledge", ctx.branchId, knowledgeId);
      if (!existingKnowledge) {
        const isFaction = Boolean(ctx.tables.selectOne("factions", ctx.branchId, recipientId));
        const row2 = createRow(
          "knowledge",
          {
            knower_character_id: isFaction ? null : recipientId,
            knower_faction_id: isFaction ? recipientId : null,
            is_pov: 0,
            information_id: infoId,
            first_received_at_s: ctx.clockS,
            belief: "heard",
            attention: "normal",
            status: "active"
          },
          { branchId: ctx.branchId, id: knowledgeId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: "atlas-1" }
        );
        result.mutations.push(mutation4("knowledge", knowledgeId, null, row2, op, basisOf3(ctx, op)));
      }
    }
    if (!kind) result.issues.push(issue7("ENUM_INVALID", "$.data.kind", "信息性质无法解析", op));
    return result;
  }
  function compileAttentionPropose(op, ctx) {
    const result = emptyCompileResult();
    const data = op.value.data ?? {};
    const known = /* @__PURE__ */ new Set(["opportunity_ref", "belief", "attention", "thought", "action_tendency", "reaction_goal"]);
    const unknown = Object.keys(data).filter((k) => !known.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const opportunityRef = op.value.ref?.trim() || asString(data.opportunity_ref);
    if (!opportunityRef) {
      result.issues.push(issue7("MINIMUM_FIELD_MISSING", "$.data.opportunity_ref", "attention.propose 需要 opportunity_ref", op));
      return result;
    }
    const opportunity = resolveRef(opportunityRef, ["opportunity"], ctx.scope, { opId: op.opId, line: op.line, field: "opportunity_ref" });
    if (!opportunity.entry) {
      result.issues.push(
        ...opportunity.issues.length ? opportunity.issues : [issue7("OPPORTUNITY_UNKNOWN", "$.data.opportunity_ref", `没有这个接触机会：${opportunityRef}；无机会不能让人物凭空获知消息`, op)]
      );
      return result;
    }
    const belief = data.belief === void 0 ? "" : String(data.belief);
    if (!BELIEF.includes(belief)) {
      result.issues.push(issue7("MINIMUM_FIELD_MISSING", "$.data.belief", "attention.propose 需要 belief=heard/doubted/believed/verified/rejected", op));
      return result;
    }
    let attention = "normal";
    if (data.attention !== void 0) {
      const a = String(data.attention);
      if (!ATTENTION.includes(a)) {
        result.issues.push(issue7("ENUM_INVALID", "$.data.attention", `attention 非法：${a}`, op));
        return result;
      }
      attention = a;
    }
    const row2 = ctx.tables.selectOne("knowledge", ctx.branchId, opportunity.entry.id);
    const turnId = ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
    if (!row2) {
      const receiver = ctx.tables.selectOne("characters", ctx.branchId, opportunity.entry.id);
      const informationId = ctx.tables.selectOne("information", ctx.branchId, opportunity.entry.id);
      if (!receiver || !informationId) {
        result.issues.push(
          issue7(
            "OPPORTUNITY_NOT_MATERIALIZED",
            "$.data.opportunity_ref",
            `机会 ${opportunity.entry.id} 尚未物化为接收者+信息的认知行：请由程序先建立机会`,
            op
          )
        );
        return result;
      }
    }
    const target = row2 ?? {
      branch_id: ctx.branchId,
      id: opportunity.entry.id,
      row_rev: 1,
      created_turn_id: turnId,
      updated_turn_id: turnId,
      knower_character_id: opportunity.entry.id,
      knower_faction_id: null,
      is_pov: 0,
      information_id: opportunity.entry.id,
      first_received_at_s: ctx.clockS,
      belief: "heard",
      attention: "normal",
      reaction_note: "",
      status: "active"
    };
    const after = applyPatch(target, {
      belief,
      attention,
      reaction_note: asString(data.thought) ?? String(target.reaction_note ?? ""),
      last_confirmed_at_s: ctx.clockS,
      row_rev: Number(target.row_rev ?? 1) + 1,
      updated_turn_id: turnId
    });
    result.mutations.push(mutation4("knowledge", String(target.id), row2, after, op, basisOf3(ctx, op)));
    if (row2) result.readSet.push({ table: "knowledge", rowId: String(target.id), rowRev: Number(row2.row_rev ?? 1) });
    if (typeof data.action_tendency === "string" || typeof data.thought === "string") {
      const knowerId = target.knower_character_id ? String(target.knower_character_id) : null;
      if (knowerId) {
        const character = ctx.tables.selectOne("characters", ctx.branchId, knowerId);
        if (character) {
          const charAfter = applyPatch(character, {
            thought: typeof data.thought === "string" ? data.thought : character.thought,
            action_tendency: typeof data.action_tendency === "string" ? data.action_tendency : character.action_tendency,
            row_rev: Number(character.row_rev ?? 1) + 1,
            updated_turn_id: turnId
          });
          result.mutations.push(mutation4("characters", knowerId, character, charAfter, op, basisOf3(ctx, op)));
          result.readSet.push({ table: "characters", rowId: knowerId, rowRev: Number(character.row_rev ?? 1) });
        }
      }
    }
    result.effects = [{ kind: "attention_accepted", opportunityId: opportunity.entry.id, belief, attention }];
    return result;
  }
  function compileChannelUpsert(op, ctx) {
    const result = emptyCompileResult();
    const data = op.value.data ?? {};
    const known = /* @__PURE__ */ new Set([
      "owner_ref",
      "kind",
      "name",
      "source_ref",
      "source_location_ref",
      "recipient_ref",
      "recipient_location_ref",
      "scope",
      "requirements",
      "latency",
      "transport_mode",
      "reliability",
      "secrecy"
    ]);
    const unknown = Object.keys(data).filter((k) => !known.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const ref = op.value.ref?.trim();
    const existing = ref && !ref.startsWith("new:") ? resolveRef(ref, "channel", ctx.scope, { opId: op.opId, line: op.line, field: "ref" }) : null;
    if (ref && !ref.startsWith("new:") && !existing?.entry) {
      result.issues.push(...existing?.issues ?? [issue7("REF_UNKNOWN", "$.ref", `找不到渠道引用：${ref}`, op)]);
      return result;
    }
    const creating = !existing?.entry;
    const resolveOne = (value, kinds, field) => {
      if (typeof value !== "string" || value.trim() === "") return null;
      const r = resolveRef(value, kinds, ctx.scope, { opId: op.opId, field });
      if (!r.entry) {
        result.issues.push(...r.issues);
        return null;
      }
      return r.entry.id;
    };
    const ownerId = resolveOne(data.owner_ref, ["character", "faction", "item"], "owner_ref");
    if (creating && !ownerId) {
      result.issues.push(issue7("MINIMUM_FIELD_MISSING", "$.data.owner_ref", "channel.upsert 需要 owner_ref", op));
      return result;
    }
    const kind = data.kind === void 0 ? "" : String(data.kind);
    if (creating && !CHANNEL_KINDS.includes(kind)) {
      result.issues.push(issue7("MINIMUM_FIELD_MISSING", "$.data.kind", `channel.upsert 需要 kind（${CHANNEL_KINDS.join("/")}）`, op));
      return result;
    }
    const name = asString(data.name);
    if (creating && !name) {
      result.issues.push(issue7("MINIMUM_FIELD_MISSING", "$.data.name", "channel.upsert 需要 name", op));
      return result;
    }
    const sourceEntityId = resolveOne(data.source_ref, ["character", "faction", "item"], "source_ref");
    const sourceLocationId = resolveOne(data.source_location_ref, ["location"], "source_location_ref");
    const recipientEntityId = resolveOne(data.recipient_ref, ["character", "faction"], "recipient_ref");
    const recipientLocationId = resolveOne(data.recipient_location_ref, ["location"], "recipient_location_ref");
    if (recipientEntityId && recipientLocationId) {
      result.issues.push(issue7("CHANNEL_RECIPIENT_CONFLICT", "$.data", "recipient 实体/地点至多一个", op));
      return result;
    }
    if (data.scope !== void 0 && data.scope !== null && !isPlainObject6(data.scope)) {
      result.issues.push(issue7("FIELD_TYPE_INVALID", "$.data.scope", "scope 必须是 {location_refs,entity_refs,radius_m?,topics}", op));
      return result;
    }
    const scope = isPlainObject6(data.scope) ? data.scope : { location_refs: [], entity_refs: [], topics: [] };
    const scopeLocationRefs = [];
    if (Array.isArray(scope.location_refs)) {
      for (const v of scope.location_refs) {
        const id = resolveOne(v, ["location"], "scope.location_refs");
        if (id) scopeLocationRefs.push(id);
      }
    }
    const scopeEntityRefs = [];
    if (Array.isArray(scope.entity_refs)) {
      for (const v of scope.entity_refs) {
        const id = resolveOne(v, null, "scope.entity_refs");
        if (id) scopeEntityRefs.push(id);
      }
    }
    const hasScope = scopeLocationRefs.length > 0 || scopeEntityRefs.length > 0;
    if (creating && !sourceEntityId && !sourceLocationId && !hasScope) {
      result.issues.push(
        issue7("CHANNEL_SCOPE_REQUIRED", "$.data", "渠道必须至少有一项 source_ref / source_location_ref 或有效 scope；范围不能默认为整个世界", op)
      );
      return result;
    }
    let reliability = "unknown";
    if (data.reliability !== void 0) {
      const r = String(data.reliability);
      if (!RELIABILITY.includes(r)) {
        result.issues.push(issue7("ENUM_INVALID", "$.data.reliability", `reliability 非法：${r}`, op));
        return result;
      }
      reliability = r;
    }
    let secrecy = "restricted";
    if (data.secrecy !== void 0) {
      const s = String(data.secrecy);
      if (!SECRECY2.includes(s)) {
        result.issues.push(issue7("ENUM_INVALID", "$.data.secrecy", `secrecy 非法：${s}`, op));
        return result;
      }
      secrecy = s;
    }
    if (data.requirements !== void 0 && data.requirements !== null && !isPlainObject6(data.requirements)) {
      result.issues.push(issue7("FIELD_TYPE_INVALID", "$.data.requirements", "requirements 必须是条件对象", op));
      return result;
    }
    const turnId = ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
    const rowId = existing?.entry ? existing.entry.id : ctx.makeId("channel", op.opId, ref && ref.startsWith("new:") ? ref : `chan:${name}`);
    const before = existing?.entry ? ctx.tables.selectOne("channels", ctx.branchId, rowId) : null;
    const changes = {
      name: name ?? before?.name ?? "",
      kind: CHANNEL_KINDS.includes(kind) ? kind : before?.kind ?? "other",
      owner_entity_id: ownerId ?? before?.owner_entity_id ?? "",
      source_entity_id: sourceEntityId,
      source_location_id: sourceLocationId,
      recipient_entity_id: recipientEntityId,
      recipient_location_id: recipientLocationId,
      scope_json: { location_refs: scopeLocationRefs, entity_refs: scopeEntityRefs, radius_m: scope.radius_m ?? null, topics: Array.isArray(scope.topics) ? scope.topics : [] },
      requirements_json: data.requirements ?? null,
      latency_json: isPlainObject6(data.latency) ? data.latency : { quality: "unknown", basis_refs: [] },
      transport_mode_key: typeof data.transport_mode === "string" ? data.transport_mode : null,
      reliability,
      secrecy
    };
    if (result.issues.some((i) => i.severity === "error")) return result;
    if (before) {
      const after = applyPatch(before, { ...changes, row_rev: Number(before.row_rev ?? 1) + 1, updated_turn_id: turnId });
      result.mutations.push(mutation4("channels", rowId, before, after, op, basisOf3(ctx, op)));
      result.readSet.push({ table: "channels", rowId, rowRev: Number(before.row_rev ?? 1) });
    } else {
      const row2 = createRow("channels", changes, {
        branchId: ctx.branchId,
        id: rowId,
        turnId,
        clockS: ctx.clockS,
        nowWallMs: Date.now(),
        rulesetVersion: "atlas-1"
      });
      result.mutations.push(mutation4("channels", rowId, null, row2, op, basisOf3(ctx, op)));
    }
    return result;
  }

  // src/atlas-ops-geography.ts
  var ROUTE_KINDS = ["adjacent", "road", "path", "door", "stairs", "air", "water", "portal", "estimated"];
  var GEOMETRY_QUALITY = ["confirmed", "estimated", "unknown"];
  var DISTANCE_BASIS = ["measured", "calibrated", "narrative", "estimated", "unknown"];
  var SCALE_QUALITY = ["uncalibrated", "estimated", "confirmed"];
  var MOBILITY_MODES = ["walk", "ride", "ground_vehicle", "water", "flight", "teleport", "custom"];
  function issue8(code, path, message, op, extra = {}) {
    return { code, path, message, severity: "error", retryable: true, opId: op.opId, line: op.line, ...extra };
  }
  function isPlainObject7(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function mutation5(table, rowId, before, after, op, basis) {
    return { table, rowId, before, after, sourceOpIds: [op.opId], basis };
  }
  function basisOf4(ctx, op) {
    if (ctx.basisFor) return ctx.basisFor(op, { certainty: "inferred" });
    return {
      kind: ctx.phase === "geography" ? "estimate" : ctx.phase === "observe" ? "story" : "simulation",
      sources: [],
      causes: [],
      reason: op.value.why ?? "地理语义操作",
      verification: ctx.phase === "observe" ? "source_bound" : "causal",
      certainty: "inferred"
    };
  }
  function compileMapEstimate(op, ctx) {
    const result = emptyCompileResult();
    const data = op.value.data ?? {};
    const known = /* @__PURE__ */ new Set(["width_m", "height_m", "meters_per_cell_min", "meters_per_cell_max", "basis", "frame", "scale_quality"]);
    const unknown = Object.keys(data).filter((k) => !known.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const ref = op.value.ref?.trim();
    if (!ref) {
      result.issues.push(issue8("MINIMUM_FIELD_MISSING", "$.ref", "map.estimate 需要 ref", op));
      return result;
    }
    const resolved = resolveRef(ref, "map", ctx.scope, { opId: op.opId, line: op.line, field: "ref" });
    if (!resolved.entry) {
      result.issues.push(...resolved.issues);
      return result;
    }
    const mapId = resolved.entry.id;
    const before = ctx.tables.selectOne("maps", ctx.branchId, mapId);
    if (!before) {
      result.issues.push(issue8("REF_UNKNOWN", "$.ref", `地图行不存在：${mapId}`, op));
      return result;
    }
    if (Number(before.scale_locked) === 1) {
      result.issues.push(issue8("MAP_SCALE_LOCKED", "$.ref", "用户已锁定该图标定，map.estimate 不修改", op, { retryable: false }));
      return result;
    }
    const widthM = typeof data.width_m === "number" && Number.isFinite(data.width_m) ? data.width_m : null;
    const heightM = typeof data.height_m === "number" && Number.isFinite(data.height_m) ? data.height_m : null;
    const minCell = typeof data.meters_per_cell_min === "number" && Number.isFinite(data.meters_per_cell_min) ? data.meters_per_cell_min : null;
    const maxCell = typeof data.meters_per_cell_max === "number" && Number.isFinite(data.meters_per_cell_max) ? data.meters_per_cell_max : null;
    const basis = asString(data.basis);
    if (widthM === null && heightM === null && minCell === null && maxCell === null) {
      result.issues.push(
        issue8("MINIMUM_FIELD_MISSING", "$.data", "map.estimate 需要尺寸（width_m/height_m）或比例尺依据（meters_per_cell_min/max）；不能声称精确测量", op)
      );
      return result;
    }
    for (const [name, value] of [["width_m", widthM], ["height_m", heightM], ["meters_per_cell_min", minCell], ["meters_per_cell_max", maxCell]]) {
      if (value !== null && value <= 0) {
        result.issues.push(issue8("MAP_SCALE_NOT_POSITIVE", `$.data.${name}`, `${name} 必须为正数`, op));
        return result;
      }
    }
    if (minCell !== null && maxCell !== null && minCell > maxCell) {
      result.issues.push(issue8("MAP_SCALE_ORDER_INVALID", "$.data", "meters_per_cell_min 不能大于 meters_per_cell_max", op));
      return result;
    }
    const frame = isPlainObject7(before.frame_json) ? before.frame_json : {};
    const refWidth = typeof frame.reference_width_cells === "number" && frame.reference_width_cells > 0 ? frame.reference_width_cells : null;
    const refHeight = typeof frame.reference_height_cells === "number" && frame.reference_height_cells > 0 ? frame.reference_height_cells : null;
    let nominal = null;
    let lower = minCell;
    let upper = maxCell;
    if (widthM !== null && refWidth) {
      nominal = widthM / refWidth;
      if (lower === null || lower > nominal) lower = nominal;
    }
    if (heightM !== null && refHeight) {
      const fromHeight = heightM / refHeight;
      nominal = nominal === null ? fromHeight : (nominal + fromHeight) / 2;
      if (lower === null || lower > fromHeight) lower = Math.min(lower ?? fromHeight, fromHeight);
      if (upper === null || upper < fromHeight) upper = fromHeight;
    }
    if (nominal === null && lower !== null && upper !== null) nominal = (lower + upper) / 2;
    if (nominal === null) nominal = lower ?? upper;
    if (nominal !== null && lower !== null && nominal < lower) lower = nominal;
    if (nominal !== null && upper !== null && nominal > upper) {
      nominal = upper;
    }
    const quality = data.scale_quality !== void 0 && SCALE_QUALITY.includes(String(data.scale_quality)) ? String(data.scale_quality) : "estimated";
    const turnId = ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
    const after = applyPatch(before, {
      meters_per_cell: nominal,
      scale_min_meters_per_cell: lower,
      scale_max_meters_per_cell: upper,
      scale_quality: quality,
      scale_basis_json: { refs: [], note: basis ?? "地图幅面估计", basis: "AI 尺寸判断" },
      calibration_rev: Number(before.calibration_rev ?? 1) + 1,
      row_rev: Number(before.row_rev ?? 1) + 1,
      updated_turn_id: turnId
    });
    result.mutations.push(mutation5("maps", mapId, before, after, op, basisOf4(ctx, op)));
    result.readSet.push({ table: "maps", rowId: mapId, rowRev: Number(before.row_rev ?? 1) });
    return result;
  }
  function validateGeometry(geometry, op, issues, path) {
    if (geometry === void 0 || geometry === null) return null;
    if (!isPlainObject7(geometry)) {
      issues.push(issue8("GEOMETRY_INVALID", path, "geometry 必须是 {kind,coordinates}", op));
      return null;
    }
    const kind = String(geometry.kind ?? "");
    if (!["point", "line", "polygon"].includes(kind)) {
      issues.push(issue8("GEOMETRY_INVALID", path, `geometry.kind 非法：${kind}`, op));
      return null;
    }
    if (!Array.isArray(geometry.coordinates)) {
      issues.push(issue8("GEOMETRY_INVALID", path, "geometry.coordinates 必须是数组", op));
      return null;
    }
    if (geometry.coordinates.length > GEOMETRY_VERTEX_LIMIT) {
      issues.push(issue8("GEOMETRY_TOO_MANY_VERTICES", path, `geometry 顶点上限 ${GEOMETRY_VERTEX_LIMIT}，收到 ${geometry.coordinates.length}`, op));
      return null;
    }
    const coords = [];
    for (const point of geometry.coordinates) {
      const pair = Array.isArray(point) ? point : isPlainObject7(point) ? [point.x, point.y] : null;
      if (!pair || pair.length < 2) {
        issues.push(issue8("GEOMETRY_INVALID", path, "geometry.coordinates 每项必须是 [x,y]", op));
        return null;
      }
      const x = Number(pair[0]);
      const y = Number(pair[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        issues.push(issue8("GEOMETRY_INVALID", path, "geometry 坐标必须是有限数字（NaN/Infinity 非法）", op));
        return null;
      }
      coords.push([x, y]);
    }
    return { kind, coordinates: coords };
  }
  function compileRoutePropose(op, ctx) {
    const result = emptyCompileResult();
    const data = op.value.data ?? {};
    const known = /* @__PURE__ */ new Set([
      "from_ref",
      "to_ref",
      "kind",
      "bidirectional",
      "map_ref",
      "geometry",
      "quality",
      "distance_m",
      "distance_min_m",
      "distance_max_m",
      "terrain",
      "modes",
      "access",
      "duration"
    ]);
    const unknown = Object.keys(data).filter((k) => !known.has(k));
    if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));
    const ref = op.value.ref?.trim();
    const existingRow = ref && !ref.startsWith("new:") ? resolveRef(ref, "route", ctx.scope, { opId: op.opId, line: op.line, field: "ref" }) : null;
    if (ref && !ref.startsWith("new:") && !existingRow?.entry) {
      result.issues.push(...existingRow?.issues ?? [issue8("REF_UNKNOWN", "$.ref", `找不到路线引用：${ref}`, op)]);
      return result;
    }
    const fromRef = data.from_ref ?? null;
    const toRef = data.to_ref ?? null;
    let fromId = null;
    let toId = null;
    if (fromRef !== null) {
      const r = resolveRef(String(fromRef), "location", ctx.scope, { opId: op.opId, field: "from_ref" });
      if (!r.entry) result.issues.push(...r.issues);
      else fromId = r.entry.id;
    }
    if (toRef !== null) {
      const r = resolveRef(String(toRef), "location", ctx.scope, { opId: op.opId, field: "to_ref" });
      if (!r.entry) result.issues.push(...r.issues);
      else toId = r.entry.id;
    }
    const rowId = existingRow?.entry ? existingRow.entry.id : ctx.makeId("route", op.opId, ref && ref.startsWith("new:") ? ref : `route:${fromId}:${toId}`);
    const before = existingRow?.entry ? ctx.tables.selectOne("routes", ctx.branchId, rowId) : null;
    if (existingRow?.entry && !before) {
      result.issues.push(issue8("REF_UNKNOWN", "$.ref", `路线行不存在：${rowId}`, op));
      return result;
    }
    if (!fromId) fromId = before ? String(before.from_location_id) : null;
    if (!toId) toId = before ? String(before.to_location_id) : null;
    if (!fromId || !toId) {
      result.issues.push(issue8("MINIMUM_FIELD_MISSING", "$.data", "route.propose 需要 from_ref 与 to_ref", op));
      return result;
    }
    if (fromId === toId) {
      result.issues.push(issue8("ROUTE_SELF_LOOP", "$.data", "路线两端不能是同一地点", op));
      return result;
    }
    const geometry = validateGeometry(data.geometry, op, result.issues, "$.data.geometry");
    const mapIdRaw = data.map_ref;
    let mapId = before ? before.map_id : null;
    if (mapIdRaw !== void 0) {
      if (mapIdRaw === null) mapId = null;
      else {
        const r = resolveRef(String(mapIdRaw), "map", ctx.scope, { opId: op.opId, field: "map_ref" });
        if (!r.entry) result.issues.push(...r.issues);
        else mapId = r.entry.id;
      }
    }
    const fromRow = ctx.tables.selectOne("locations", ctx.branchId, fromId);
    const toRow = ctx.tables.selectOne("locations", ctx.branchId, toId);
    const fromMap = fromRow?.map_id ? String(fromRow.map_id) : null;
    const toMap = toRow?.map_id ? String(toRow.map_id) : null;
    if (geometry && mapId && fromMap && toMap && fromMap !== toMap) {
      result.issues.push(
        issue8("ROUTE_GEOMETRY_CROSS_MAP", "$.data.geometry", "两端地点属于不同地图：跨图连接不要给几何（用两端地点与耗时表达）", op)
      );
      return result;
    }
    let kind = before ? String(before.kind) : "estimated";
    if (data.kind !== void 0) {
      const k = String(data.kind);
      if (!ROUTE_KINDS.includes(k)) {
        result.issues.push(issue8("ENUM_INVALID", "$.data.kind", `路线类型非法：${k}`, op));
        return result;
      }
      kind = k;
    }
    let quality = geometry ? "confirmed" : before ? String(before.geometry_quality) : "unknown";
    if (data.quality !== void 0) {
      const q = String(data.quality);
      if (!GEOMETRY_QUALITY.includes(q)) {
        result.issues.push(issue8("ENUM_INVALID", "$.data.quality", `geometry quality 非法：${q}`, op));
        return result;
      }
      quality = q;
    }
    const distanceM = typeof data.distance_m === "number" && Number.isFinite(data.distance_m) ? data.distance_m : null;
    const distanceMin = typeof data.distance_min_m === "number" && Number.isFinite(data.distance_min_m) ? data.distance_min_m : null;
    const distanceMax = typeof data.distance_max_m === "number" && Number.isFinite(data.distance_max_m) ? data.distance_max_m : null;
    for (const [name, value] of [["distance_m", distanceM], ["distance_min_m", distanceMin], ["distance_max_m", distanceMax]]) {
      if (value !== null && value < 0) {
        result.issues.push(issue8("DISTANCE_NEGATIVE", `$.data.${name}`, `${name} 不能为负`, op));
        return result;
      }
    }
    if (distanceMin !== null && distanceM !== null && distanceMin > distanceM) {
      result.issues.push(issue8("DISTANCE_ORDER_INVALID", "$.data", "distance_min_m 不能大于 distance_m", op));
      return result;
    }
    if (distanceMax !== null && distanceM !== null && distanceM > distanceMax) {
      result.issues.push(issue8("DISTANCE_ORDER_INVALID", "$.data", "distance_m 不能大于 distance_max_m", op));
      return result;
    }
    if (distanceMin !== null && distanceMax !== null && distanceMin > distanceMax) {
      result.issues.push(issue8("DISTANCE_ORDER_INVALID", "$.data", "distance_min_m 不能大于 distance_max_m", op));
      return result;
    }
    const modes = [];
    if (Array.isArray(data.modes)) {
      for (const m of data.modes) {
        const mode = String(m);
        if (!MOBILITY_MODES.includes(mode)) {
          result.issues.push(issue8("ENUM_INVALID", "$.data.modes", `移动方式非法：${mode}`, op));
          return result;
        }
        modes.push(mode);
      }
    }
    if (data.access !== void 0 && data.access !== null && !isPlainObject7(data.access)) {
      result.issues.push(issue8("FIELD_TYPE_INVALID", "$.data.access", "access 必须是条件对象", op));
      return result;
    }
    if (data.duration !== void 0 && data.duration !== null && !isPlainObject7(data.duration)) {
      result.issues.push(issue8("FIELD_TYPE_INVALID", "$.data.duration", "duration 必须是 TimeEstimate 对象", op));
      return result;
    }
    const distanceBasis = before ? String(before.distance_basis) : "unknown";
    const resolvedBasis = distanceM !== null || distanceMin !== null || distanceMax !== null ? data.quality === "confirmed" ? "calibrated" : "estimated" : distanceBasis;
    if (!DISTANCE_BASIS.includes(resolvedBasis)) {
      result.issues.push(issue8("ENUM_INVALID", "$.data", "distance_basis 无法确定", op));
      return result;
    }
    if (result.issues.some((i) => i.severity === "error")) return result;
    const turnId = ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
    if (before) {
      const after = applyPatch(before, {
        from_location_id: fromId,
        to_location_id: toId,
        kind,
        bidirectional: data.bidirectional === void 0 ? before.bidirectional : data.bidirectional ? 1 : 0,
        map_id: mapId,
        geometry_json: geometry ?? (data.geometry === void 0 ? before.geometry_json : null),
        geometry_quality: quality,
        geometry_rev: geometry ? Number(before.geometry_rev ?? 1) + 1 : Number(before.geometry_rev ?? 1),
        distance_m: distanceM ?? before.distance_m,
        distance_min_m: distanceMin ?? before.distance_min_m,
        distance_max_m: distanceMax ?? before.distance_max_m,
        distance_basis: resolvedBasis,
        terrain: data.terrain === void 0 ? before.terrain : asString(data.terrain) ?? "unknown",
        allowed_modes_json: data.modes === void 0 ? before.allowed_modes_json : modes,
        access_rules_json: data.access === void 0 ? before.access_rules_json : data.access,
        travel_time_override_json: data.duration === void 0 ? before.travel_time_override_json : data.duration,
        row_rev: Number(before.row_rev ?? 1) + 1,
        updated_turn_id: turnId
      });
      result.mutations.push(mutation5("routes", rowId, before, after, op, basisOf4(ctx, op)));
      result.readSet.push({ table: "routes", rowId, rowRev: Number(before.row_rev ?? 1) });
    } else {
      const row2 = createRow(
        "routes",
        {
          from_location_id: fromId,
          to_location_id: toId,
          kind,
          bidirectional: data.bidirectional === void 0 ? 1 : data.bidirectional ? 1 : 0,
          map_id: mapId,
          geometry_json: geometry,
          geometry_quality: quality,
          distance_m: distanceM,
          distance_min_m: distanceMin,
          distance_max_m: distanceMax,
          distance_basis: resolvedBasis,
          terrain: asString(data.terrain) ?? "unknown",
          allowed_modes_json: modes,
          access_rules_json: data.access ?? null,
          travel_time_override_json: data.duration ?? null
        },
        { branchId: ctx.branchId, id: rowId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: "atlas-1" }
      );
      result.mutations.push(mutation5("routes", rowId, null, row2, op, basisOf4(ctx, op)));
    }
    result.declaredRefs = ref?.startsWith("new:") ? [{ alias: ref, id: rowId, kind: "route", rowRev: null, declaredByOpId: op.opId }] : [];
    return result;
  }

  // src/atlas-ops-compile.ts
  function defaultMakeId2(anchor) {
    return (kind, opId, alias) => {
      const prefix = refKindPrefix(kind);
      const text = `${anchor.chatUid}\0${anchor.branchId}\0${anchor.variantKey}\0${alias}\0${opId}`;
      return `${prefix}_${stableHash2(text, 24)}`;
    };
  }
  function stableHash2(text, length = 24) {
    let out = "";
    let seed = 2166136261;
    while (out.length < length) {
      let h = seed;
      for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i) + out.length;
        h = Math.imul(h, 16777619) >>> 0;
      }
      out += h.toString(16).padStart(8, "0");
      seed = (h ^ 2654435769) >>> 0;
    }
    return out.slice(0, length);
  }
  var COMPILERS = {
    "location.upsert": compileLocationUpsert,
    "character.upsert": compileCharacterUpsert,
    "item.upsert": compileItemUpsert,
    "item.transfer": compileItemTransfer,
    "faction.upsert": compileFactionUpsert,
    "relation.upsert": compileRelationUpsert,
    "plan.propose": compilePlanPropose,
    "plan.revise": compilePlanRevise,
    "event.propose": compileEventPropose,
    "information.propose": compileInformationPropose,
    "attention.propose": compileAttentionPropose,
    "channel.upsert": compileChannelUpsert,
    "map.estimate": compileMapEstimate,
    "route.propose": compileRoutePropose
  };
  function compilerFor(op) {
    return COMPILERS[op] ?? null;
  }
  function compileOperations(input) {
    const issues = [];
    const normalized = [];
    for (const op of input.operations) {
      const norm = normalizeOperation(op.value, input.phase, input.allowedOps);
      issues.push(...norm.issues.map((i) => ({ ...i, opId: i.opId ?? op.opId, line: i.line ?? op.line })));
      if (!norm.op) continue;
      normalized.push({ opId: op.opId, line: op.line, rawHash: op.rawHash, value: norm.op });
    }
    const makeId = input.makeId ?? defaultMakeId2(input.anchor);
    const declared = declareRefs(normalized, {
      anchor: input.anchor,
      baseRevision: input.revision,
      seed: input.seedRefs,
      makeId
    });
    issues.push(...declared.issues);
    const scope = createRefScope();
    for (const ref of input.knownRefs ?? []) {
      scope.declare({ alias: ref.alias, id: ref.id, kind: ref.kind, rowRev: ref.rowRev ?? null, declaredByOpId: null });
    }
    for (const entry of declared.declared) scope.declare(entry);
    const sourceIssues = [];
    const ctx = {
      phase: input.phase,
      anchor: input.anchor,
      clockS: input.clockS,
      revision: input.revision,
      scope,
      sources: input.sources,
      tables: input.tables,
      makeId,
      branchId: input.anchor.branchId,
      // 审计列按「本次正在创建的楼」记账（见 CompileContext.turnId）。
      ...input.turnId ? { turnId: input.turnId } : {},
      basisFor: (op, extra) => {
        const causes = (input.sources?.causes ?? []).map((cause) => {
          const id = typeof cause?.id === "string" ? cause.id : "";
          if (!id.startsWith("new:")) return cause;
          const alias = id.slice(4);
          const resolved = declared.aliasById.get(alias) ?? scope.get(alias)?.id ?? null;
          return resolved ? { ...cause, id: resolved } : cause;
        });
        const bound = bindSources(op.value, {
          ...input.sources,
          causes,
          opId: op.opId,
          // 前向引用合法：本批已声明的别名解析成确定性 ID，未声明的才告警。
          resolveAlias: (alias) => declared.aliasById.get(alias) ?? scope.get(alias)?.id ?? null
        });
        for (const issue10 of bound.issues ?? []) sourceIssues.push(issue10);
        const basis = { ...bound.basis };
        if (extra?.causes?.length) basis.causes = [...basis.causes, ...extra.causes];
        if (extra?.certainty) basis.certainty = extra.certainty;
        return basis;
      }
    };
    const results = [];
    for (const op of normalized) {
      const minimum = validateMinimum(op.value, input.phase, { opId: op.opId, line: op.line });
      if (!minimum.ok) {
        issues.push(minimum.issue);
        results.push({ opId: op.opId, result: { ...emptyCompileResult(), issues: [minimum.issue] } });
        continue;
      }
      const compiler = compilerFor(op.value.op);
      if (!compiler) {
        const issue10 = {
          code: "UNKNOWN_OPERATION",
          path: "$.op",
          message: `没有这个语义操作：${op.value.op}`,
          severity: "error",
          retryable: true,
          opId: op.opId,
          line: op.line
        };
        issues.push(issue10);
        results.push({ opId: op.opId, result: { ...emptyCompileResult(), issues: [issue10] } });
        continue;
      }
      let compiled;
      try {
        compiled = compiler(op, ctx);
      } catch (err) {
        const issue10 = {
          code: "INTERNAL_ERROR",
          path: "$",
          message: `编译 ${op.value.op} 时内部错误：${err.message}`,
          severity: "error",
          retryable: false,
          opId: op.opId,
          line: op.line
        };
        issues.push(issue10);
        results.push({ opId: op.opId, result: { ...emptyCompileResult(), issues: [issue10] } });
        continue;
      }
      for (const ref of compiled.declaredRefs ?? []) {
        if (!scope.get(ref.alias)) scope.declare(ref);
      }
      issues.push(...compiled.issues);
      results.push({ opId: op.opId, result: { ...compiled, issues: compiled.issues } });
    }
    const seenSource = new Set(issues.map((i) => `${i.opId ?? ""}|${i.code}|${i.path}`));
    for (const issue10 of sourceIssues) {
      const key = `${issue10.opId ?? ""}|${issue10.code}|${issue10.path}`;
      if (seenSource.has(key)) continue;
      seenSource.add(key);
      issues.push(issue10);
    }
    const merged = mergeCompileResults(results.map((r) => r.result));
    return { results, merged, issues, scope, aliasById: declared.aliasById, normalized };
  }

  // src/atlas-hash.ts
  var nodeCrypto;
  function getNodeCrypto() {
    if (nodeCrypto !== void 0) return nodeCrypto;
    try {
      const proc = globalThis.process;
      if (proc && typeof proc.getBuiltinModule === "function") {
        const mod = proc.getBuiltinModule("node:crypto");
        nodeCrypto = mod && typeof mod.createHash === "function" ? mod : null;
        return nodeCrypto;
      }
    } catch {
    }
    nodeCrypto = null;
    return nodeCrypto;
  }
  function pureHash(text) {
    let h1 = 2166136261;
    let h2 = 16777619;
    let h3 = 2654435769;
    let h4 = 2246822507;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = (Math.imul(h2 ^ c, 2246822507) >>> 0) + c;
      h3 = Math.imul(h3 ^ c, 3266489909) >>> 0;
      h4 = (h4 ^ c + i) >>> 0;
      h4 = Math.imul(h4, 668265263) >>> 0;
    }
    const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
    return `${hex(h1)}${hex(h2)}${hex(h3)}${hex(h4)}`;
  }
  function stableHexHash(text) {
    const crypto2 = getNodeCrypto();
    if (crypto2) return crypto2.createHash("sha256").update(text).digest("hex");
    return pureHash(text);
  }

  // src/atlas-ops-parser.ts
  var UTF8_ENCODER = new TextEncoder();
  function utf8ByteLength(text) {
    return UTF8_ENCODER.encode(text).byteLength;
  }
  var REASONING_OPEN_RE = /<(think|thinking|analysis|reasoning)(?:\s[^>]*)?>/gi;
  var REASONING_ANY_CLOSE_RE = /<\/(?:think|thinking|analysis|reasoning)\s*>/gi;
  var FENCE_LINE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
  var ATLAS_OPEN_RE = /<atlasEdit\b[^>]*>/i;
  var ATLAS_CLOSE_RE = /<\/atlasEdit\s*>/i;
  var ATLAS_HEAD_RE = /^\s*<atlasEdit\b/i;
  var FENCE_ANYWHERE_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})/m;
  var SQL_START_RE = /^(SELECT|UPDATE|INSERT|DELETE|CREATE|DROP|ALTER|PRAGMA|ATTACH|WITH|REPLACE)\b/i;
  var OPERATION_TOP_FIELDS = ["op", "ref", "data", "source", "why", "ticket"];
  var EXCERPT_CHARS = 80;
  function issue9(code, path, message, extra = {}) {
    return toIssue2(new Error(message), { code, path, ...extra });
  }
  function normalizeText(text) {
    let out = text;
    if (out.charCodeAt(0) === 65279) out = out.slice(1);
    return out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }
  function makeLineIndex(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return {
      lineAt(offset) {
        const target = Math.max(0, Math.min(offset, text.length));
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = lo + hi + 1 >> 1;
          if (starts[mid] <= target) lo = mid;
          else hi = mid - 1;
        }
        return lo + 1;
      }
    };
  }
  function isPlainObject8(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function excerptOf(text, limit = EXCERPT_CHARS) {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= limit) return flat;
    return `${flat.slice(0, limit - 1)}…`;
  }
  function sha256Hex2(text) {
    return stableHexHash(text);
  }
  function findJsonValueEnd(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let opened = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        depth += 1;
        opened = true;
        continue;
      }
      if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth <= 0 && opened) return i + 1;
        if (depth < 0) return i + 1;
      }
    }
    return -1;
  }
  function jsonNestingDepth(text) {
    let depth = 0;
    let max = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") {
        depth += 1;
        if (depth > max) max = depth;
      } else if (ch === "}" || ch === "]") depth -= 1;
    }
    return max;
  }
  function stripReasoningBlocks(text, pushIssue) {
    const lineIndex = makeLineIndex(text);
    let out = text;
    let blocked = false;
    let cursor = 0;
    while (cursor < out.length) {
      REASONING_OPEN_RE.lastIndex = cursor;
      const open = REASONING_OPEN_RE.exec(out);
      if (!open) break;
      const tag = open[1].toLowerCase();
      const openStart = open.index;
      const openEnd = open.index + open[0].length;
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const close = closeRe.exec(out.slice(openEnd));
      if (!close) {
        pushIssue(lineIndex.lineAt(openStart), tag);
        out = out.slice(0, openStart);
        blocked = true;
        break;
      }
      const closeEnd = openEnd + close.index + close[0].length;
      out = out.slice(0, openStart) + out.slice(closeEnd);
      cursor = openStart;
    }
    out = out.replace(REASONING_ANY_CLOSE_RE, "");
    return { text: out, blocked };
  }
  var FENCE_LANG_RE = /^\s*(?:json|jsonc|json5|javascript|js|sql|text|plaintext|txt|markdown|md|yaml|yml|xml|html|bash|sh|none)\s+/i;
  function stripCodeFences(text) {
    const lines = text.split("\n");
    const out = [];
    let fenceChar = null;
    for (const line of lines) {
      const match = FENCE_LINE_RE.exec(line);
      if (match) {
        const marker = match[1];
        const rest = match[2];
        const restTrimmed = rest.trim();
        if (fenceChar === null) {
          const bareInfo = restTrimmed === "" || /^[A-Za-z0-9_+-]+$/.test(restTrimmed);
          if (bareInfo) {
            fenceChar = marker.charAt(0);
            continue;
          }
          let inner = rest;
          const closing = /(`{3,}|~{3,})\s*$/.exec(inner);
          if (closing) inner = inner.slice(0, closing.index);
          const bracket = inner.search(/[{[]/);
          if (bracket >= 0) inner = inner.slice(bracket);
          else inner = inner.replace(FENCE_LANG_RE, "");
          out.push(inner.trim());
          continue;
        }
        if (marker.charAt(0) === fenceChar && restTrimmed === "") {
          fenceChar = null;
          continue;
        }
      }
      out.push(line);
    }
    return out.join("\n");
  }
  function stripWrapperShell(text) {
    const open = ATLAS_OPEN_RE.exec(text);
    if (!open) return text;
    const afterOpen = open.index + open[0].length;
    const close = ATLAS_CLOSE_RE.exec(text.slice(afterOpen));
    return close ? text.slice(afterOpen, afterOpen + close.index) : text.slice(afterOpen);
  }
  function extractPayload(text) {
    const issues = [];
    const source = normalizeText(typeof text === "string" ? text : "");
    const reasoning = stripReasoningBlocks(source, (blockedLine, tag) => {
      issues.push(
        issue9(
          ATLAS_ERROR_CODES.UNTERMINATED_REASONING,
          "$.reasoning",
          `unterminated <${tag}> block opened on line ${blockedLine}; nothing after it is extracted`,
          { severity: "error", line: blockedLine, retryable: true }
        )
      );
    });
    let body = stripCodeFences(reasoning.text);
    let incomplete = reasoning.blocked;
    const open = ATLAS_OPEN_RE.exec(body);
    if (open) {
      const afterOpen = open.index + open[0].length;
      const close = ATLAS_CLOSE_RE.exec(body.slice(afterOpen));
      const openLine = makeLineIndex(body).lineAt(open.index);
      if (close) {
        body = body.slice(afterOpen, afterOpen + close.index);
      } else {
        issues.push(
          issue9(
            ATLAS_ERROR_CODES.WRAPPER_INCOMPLETE,
            "$.atlasEdit",
            `missing </atlasEdit> closing tag (opened on line ${openLine}); inner content kept`,
            { severity: "warning", line: openLine, retryable: false }
          )
        );
        body = body.slice(afterOpen);
        incomplete = true;
      }
    } else {
      const closeOnly = ATLAS_CLOSE_RE.exec(body);
      if (closeOnly) {
        const closeLine = makeLineIndex(body).lineAt(closeOnly.index);
        issues.push(
          issue9(
            ATLAS_ERROR_CODES.WRAPPER_INCOMPLETE,
            "$.atlasEdit",
            `stray </atlasEdit> closing tag without opening tag on line ${closeLine}; tag stripped`,
            { severity: "warning", line: closeLine, retryable: false }
          )
        );
        body = body.slice(0, closeOnly.index) + body.slice(closeOnly.index + closeOnly[0].length);
        incomplete = true;
      }
    }
    const payload = body.trim() === "" ? "" : body;
    return { payload, issues, incomplete, reasoningBlocked: reasoning.blocked };
  }
  function lineCandidates(text) {
    const lines = text.split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed === "" || !trimmed.startsWith("{")) continue;
      out.push({ raw: trimmed, line: i + 1 });
    }
    return out;
  }
  function buildOperation(value, candidate, index, issues) {
    if (!isPlainObject8(value)) {
      issues.push(
        issue9(
          ATLAS_ERROR_CODES.MINIMUM_FIELD_MISSING,
          "$",
          `line ${candidate.line}: each response line must be a JSON object with a string op; got ${Array.isArray(value) ? "array" : typeof value}; excerpt: ${excerptOf(candidate.raw)}`,
          { line: candidate.line, retryable: true }
        )
      );
      return { kind: "error" };
    }
    const opRaw = typeof value["op"] === "string" ? value["op"] : "";
    if (opRaw.trim() === "") {
      issues.push(
        issue9(
          ATLAS_ERROR_CODES.MINIMUM_FIELD_MISSING,
          "$.op",
          `line ${candidate.line}: operation object is missing required string field op; minimal example: {"op":"character.upsert","ref":"C1","data":{"thought":"先观察。"}}`,
          { line: candidate.line, retryable: true }
        )
      );
      return { kind: "error" };
    }
    if (opRaw.trim().toLowerCase() === ATLAS_NOOP) return { kind: "noop" };
    const modelOp = { op: opRaw };
    const ref = value["ref"];
    if (typeof ref === "string") modelOp.ref = ref;
    else if (ref !== void 0 && ref !== null) {
      issues.push(
        issue9(ATLAS_ERROR_CODES.FIELD_IGNORED, "$.ref", `line ${candidate.line}: ref must be a string; ignored`, {
          severity: "warning",
          line: candidate.line
        })
      );
    }
    const data = value["data"];
    if (isPlainObject8(data)) modelOp.data = data;
    else if (data !== void 0 && data !== null) {
      issues.push(
        issue9(ATLAS_ERROR_CODES.FIELD_IGNORED, "$.data", `line ${candidate.line}: data must be an object; ignored`, {
          severity: "warning",
          line: candidate.line
        })
      );
    }
    const source = value["source"];
    if (typeof source === "string") modelOp.source = source;
    else if (Array.isArray(source)) {
      const list = source.filter((entry) => typeof entry === "string");
      if (list.length > 0) modelOp.source = list;
      else {
        issues.push(
          issue9(ATLAS_ERROR_CODES.FIELD_IGNORED, "$.source", `line ${candidate.line}: source array has no string entries; ignored`, {
            severity: "warning",
            line: candidate.line
          })
        );
      }
    } else if (source !== void 0 && source !== null) {
      issues.push(
        issue9(ATLAS_ERROR_CODES.FIELD_IGNORED, "$.source", `line ${candidate.line}: source must be a string or string array; ignored`, {
          severity: "warning",
          line: candidate.line
        })
      );
    }
    const why = value["why"];
    if (typeof why === "string") modelOp.why = why;
    else if (why !== void 0 && why !== null) {
      issues.push(
        issue9(ATLAS_ERROR_CODES.FIELD_IGNORED, "$.why", `line ${candidate.line}: why must be a string; ignored`, {
          severity: "warning",
          line: candidate.line
        })
      );
    }
    const ticket = value["ticket"];
    if (typeof ticket === "string") modelOp.ticket = ticket;
    else if (ticket !== void 0 && ticket !== null) {
      issues.push(
        issue9(ATLAS_ERROR_CODES.FIELD_IGNORED, "$.ticket", `line ${candidate.line}: ticket must be a string; ignored`, {
          severity: "warning",
          line: candidate.line
        })
      );
    }
    for (const key of Object.keys(value)) {
      if (OPERATION_TOP_FIELDS.includes(key)) continue;
      const systemOwned = SYSTEM_OWNED_FIELDS.includes(key);
      issues.push(
        issue9(
          systemOwned ? ATLAS_ERROR_CODES.SYSTEM_FIELD_IGNORED : ATLAS_ERROR_CODES.FIELD_IGNORED,
          `$.${key}`,
          `line ${candidate.line}: ${systemOwned ? "program-owned field" : "unknown top-level field"} ${key} ignored on ${opRaw.trim()}`,
          { severity: "warning", line: candidate.line }
        )
      );
    }
    const rawHash = sha256Hex2(candidate.raw);
    const opId = `op_${index}_${rawHash.slice(0, 8)}`;
    return { kind: "op", parsed: { opId, line: candidate.line, rawHash, value: modelOp } };
  }
  function parseOperations(payload, ctx) {
    void ctx;
    const rawInput = normalizeText(typeof payload === "string" ? payload : "");
    const issues = [];
    const operations = [];
    let explicitNoop = false;
    let incomplete = false;
    const byteLength = utf8ByteLength(rawInput);
    if (byteLength > ATLAS_RUNTIME_LIMITS.responseUtf8Bytes) {
      issues.push(
        issue9(
          ATLAS_ERROR_CODES.RESPONSE_TOO_LARGE,
          "$",
          `response is ${byteLength} bytes, over the ${ATLAS_RUNTIME_LIMITS.responseUtf8Bytes} byte limit; no operation kept (response not truncated)`,
          { retryable: false }
        )
      );
      return { operations: [], issues, explicitNoop: false, incomplete: true };
    }
    let source = rawInput;
    if (FENCE_ANYWHERE_RE.test(source)) source = stripCodeFences(source);
    if (ATLAS_HEAD_RE.test(source)) source = stripWrapperShell(source);
    const trimmed = source.trim();
    if (trimmed === "") {
      return { operations: [], issues: [], explicitNoop: false, incomplete: true };
    }
    const lineIndex = makeLineIndex(source);
    let bodyStart = source.search(/\S/);
    const firstChar = source[bodyStart];
    if (firstChar !== "{" && firstChar !== "[") {
      const head2 = /^[ \t]*([\[{])/m.exec(source);
      if (head2) bodyStart = head2.index + head2[0].length - 1;
    }
    const head = source.slice(bodyStart);
    const candidates = [];
    if (head.startsWith("[")) {
      const arrayEnd = findJsonValueEnd(source, bodyStart);
      if (arrayEnd < 0) {
        issues.push(
          issue9(
            ATLAS_ERROR_CODES.JSON_SYNTAX,
            "$",
            `JSON array is unterminated (${byteLength} bytes); excerpt: ${excerptOf(head)}`,
            { line: lineIndex.lineAt(bodyStart), retryable: true }
          )
        );
        return { operations: [], issues, explicitNoop: false, incomplete: true };
      }
      const arrayText = source.slice(bodyStart, arrayEnd);
      let parsedArray;
      try {
        parsedArray = JSON.parse(arrayText);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const at = /position (\d+)/.exec(detail);
        const offset = at ? bodyStart + Number(at[1]) : bodyStart;
        issues.push(
          issue9(
            ATLAS_ERROR_CODES.JSON_SYNTAX,
            "$",
            `JSON array is malformed (${utf8ByteLength(arrayText)} bytes): ${detail}; excerpt: ${excerptOf(arrayText)}`,
            { line: lineIndex.lineAt(offset), retryable: true }
          )
        );
        return { operations: [], issues, explicitNoop: false, incomplete: true };
      }
      if (!Array.isArray(parsedArray)) {
        issues.push(
          issue9(ATLAS_ERROR_CODES.JSON_SYNTAX, "$", `expected a JSON array; excerpt: ${excerptOf(arrayText)}`, {
            line: lineIndex.lineAt(bodyStart),
            retryable: true
          })
        );
        return { operations: [], issues, explicitNoop: false, incomplete: true };
      }
      let cursor = bodyStart + 1;
      const innerEnd = arrayEnd - 1;
      while (cursor < innerEnd) {
        while (cursor < innerEnd && (source[cursor] === "," || /\s/.test(source[cursor]))) cursor += 1;
        if (cursor >= innerEnd) break;
        const valueEnd = findJsonValueEnd(source, cursor);
        if (valueEnd < 0 || valueEnd > arrayEnd) break;
        candidates.push({ raw: source.slice(cursor, valueEnd), line: lineIndex.lineAt(cursor) });
        cursor = valueEnd;
      }
      if (candidates.length !== parsedArray.length) {
        candidates.length = 0;
        for (const element of parsedArray) {
          candidates.push({ raw: String(JSON.stringify(element)), line: lineIndex.lineAt(bodyStart) });
        }
      }
    } else if (head.startsWith("{")) {
      const valueEnd = findJsonValueEnd(source, bodyStart);
      const valueText = valueEnd > 0 ? source.slice(bodyStart, valueEnd) : "";
      const rest = valueEnd > 0 ? source.slice(valueEnd) : "";
      const restHasObjectLine = rest.split("\n").some((line) => line.trim().startsWith("{"));
      let wholeObject = false;
      if (valueEnd > 0 && valueText.includes("\n") && !restHasObjectLine) {
        try {
          JSON.parse(valueText);
          wholeObject = true;
        } catch {
          wholeObject = false;
        }
      }
      if (wholeObject) candidates.push({ raw: valueText, line: lineIndex.lineAt(bodyStart) });
      else for (const candidate of lineCandidates(source)) candidates.push(candidate);
    } else {
      for (const candidate of lineCandidates(source)) candidates.push(candidate);
    }
    const limit = ATLAS_RUNTIME_LIMITS.operationsPerResponse;
    let validCount = 0;
    let firstDroppedLine;
    for (const candidate of candidates) {
      const bytes = utf8ByteLength(candidate.raw);
      if (bytes > ATLAS_RUNTIME_LIMITS.operationUtf8Bytes) {
        issues.push(
          issue9(
            ATLAS_ERROR_CODES.OPERATION_TOO_LARGE,
            "$",
            `operation on line ${candidate.line} is ${bytes} bytes, over the ${ATLAS_RUNTIME_LIMITS.operationUtf8Bytes} byte per-operation limit; line skipped, other lines unaffected`,
            { line: candidate.line, retryable: true }
          )
        );
        incomplete = true;
        continue;
      }
      let value;
      try {
        value = JSON.parse(candidate.raw);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        issues.push(
          issue9(
            ATLAS_ERROR_CODES.JSON_SYNTAX,
            "$",
            `line ${candidate.line}: invalid JSON (${bytes} bytes): ${detail}; excerpt: ${excerptOf(candidate.raw)}`,
            { line: candidate.line, retryable: true }
          )
        );
        incomplete = true;
        continue;
      }
      const depth = jsonNestingDepth(candidate.raw);
      if (depth > ATLAS_RUNTIME_LIMITS.responseJsonDepth) {
        issues.push(
          issue9(
            ATLAS_ERROR_CODES.JSON_TOO_DEEP,
            "$",
            `line ${candidate.line}: JSON nesting depth ${depth} exceeds ${ATLAS_RUNTIME_LIMITS.responseJsonDepth}; line skipped`,
            { line: candidate.line, retryable: true }
          )
        );
        incomplete = true;
        continue;
      }
      const built = buildOperation(value, candidate, operations.length, issues);
      if (built.kind === "error") {
        incomplete = true;
        continue;
      }
      if (built.kind === "noop") {
        explicitNoop = true;
        continue;
      }
      validCount += 1;
      if (operations.length >= limit) {
        if (firstDroppedLine === void 0) firstDroppedLine = candidate.line;
        continue;
      }
      operations.push(built.parsed);
    }
    if (validCount > limit) {
      issues.push(
        issue9(
          ATLAS_ERROR_CODES.TOO_MANY_OPERATIONS,
          "$",
          `response contains ${validCount} valid operations, over the ${limit} per-response limit; kept the first ${limit} and reported the remaining ${validCount - limit} (no silent drop)`,
          { line: firstDroppedLine, retryable: true }
        )
      );
      incomplete = true;
    }
    return { operations, issues, explicitNoop, incomplete };
  }
  function looksLikeSql(text) {
    const { payload } = extractPayload(text);
    for (const line of payload.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (trimmed.includes("{")) return false;
      return SQL_START_RE.test(trimmed);
    }
    return false;
  }

  // src/atlas-ops-repair.ts
  var SHA256_K2 = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  function rotr322(value, bits) {
    return (value >>> bits | value << 32 - bits) >>> 0;
  }
  function sha256Hex3(text) {
    const message = new TextEncoder().encode(text);
    const paddedLength = (message.length + 8 >> 6) + 1 << 6;
    const buffer = new Uint8Array(paddedLength);
    buffer.set(message);
    buffer[message.length] = 128;
    const bitLength = message.length * 8;
    const view = new DataView(buffer.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296));
    view.setUint32(paddedLength - 4, bitLength >>> 0);
    const state = new Uint32Array([
      1779033703,
      3144134277,
      1013904242,
      2773480762,
      1359893119,
      2600822924,
      528734635,
      1541459225
    ]);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i += 1) {
        const x = w[i - 15];
        const y = w[i - 2];
        const s0 = rotr322(x, 7) ^ rotr322(x, 18) ^ x >>> 3;
        const s1 = rotr322(y, 17) ^ rotr322(y, 19) ^ y >>> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
      }
      let a = state[0];
      let b = state[1];
      let c = state[2];
      let d = state[3];
      let e = state[4];
      let f = state[5];
      let g = state[6];
      let h = state[7];
      for (let i = 0; i < 64; i += 1) {
        const s1 = rotr322(e, 6) ^ rotr322(e, 11) ^ rotr322(e, 25);
        const ch = e & f ^ ~e & g;
        const temp1 = h + s1 + ch + SHA256_K2[i] + w[i] >>> 0;
        const s0 = rotr322(a, 2) ^ rotr322(a, 13) ^ rotr322(a, 22);
        const maj = a & b ^ a & c ^ b & c;
        const temp2 = s0 + maj >>> 0;
        h = g;
        g = f;
        f = e;
        e = d + temp1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = temp1 + temp2 >>> 0;
      }
      state[0] = state[0] + a >>> 0;
      state[1] = state[1] + b >>> 0;
      state[2] = state[2] + c >>> 0;
      state[3] = state[3] + d >>> 0;
      state[4] = state[4] + e >>> 0;
      state[5] = state[5] + f >>> 0;
      state[6] = state[6] + g >>> 0;
      state[7] = state[7] + h >>> 0;
    }
    let hex = "";
    for (let i = 0; i < 8; i += 1) hex += state[i].toString(16).padStart(8, "0");
    return hex;
  }
  function makeIssue3(code, path, message, severity, retryable, where) {
    const issue10 = { code, path, message, severity, retryable };
    if (where?.line !== void 0) issue10.line = where.line;
    if (where?.opId !== void 0) issue10.opId = where.opId;
    return issue10;
  }
  function oneLine(text) {
    return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  }
  function cloneIssue(issue10) {
    return { ...issue10 };
  }
  function renderTicketLine(ticket, op) {
    const value = { ticket: ticket.ticket };
    const model = op?.value;
    if (model && typeof model === "object") {
      value.op = model.op;
      if (model.ref !== void 0) value.ref = model.ref;
      if (model.data !== void 0) value.data = model.data;
      if (model.source !== void 0) value.source = model.source;
      if (model.why !== void 0) value.why = model.why;
    }
    const errors = ticket.issues.map((issue10) => ({
      code: issue10.code,
      path: issue10.path,
      message: oneLine(issue10.message),
      line: issue10.line ?? op?.line ?? null
    }));
    return `${JSON.stringify(value)} ｜ ticket=${ticket.ticket} originalOpId=${ticket.originalOpId} ｜ 允许操作：${ticket.allowedOps.length > 0 ? ticket.allowedOps.join(", ") : "（无）"} ｜ 错误：${JSON.stringify(errors)}`;
  }
  function buildRepairBatch(failed, ctx) {
    const list = Array.isArray(failed) ? failed : [];
    const batchId = sha256Hex3(list.map((entry) => entry?.op?.opId ?? "").join("\0")).slice(0, 16);
    if (list.length === 0) {
      return { batchId, tickets: [], issues: [], promptLines: [] };
    }
    const tickets = [];
    const ticketLines = [];
    list.forEach((entry, index) => {
      const ticket = {
        ticket: `R${index + 1}`,
        originalOpId: entry?.op?.opId ?? "",
        allowedOps: ctx.allowedOps,
        originalReadSet: (entry?.readSet ?? []).map((row2) => ({
          table: row2.table,
          rowId: row2.rowId,
          rowRev: row2.rowRev
        })),
        issues: (entry?.issues ?? []).map(cloneIssue)
      };
      tickets.push(ticket);
      ticketLines.push(renderTicketLine(ticket, entry?.op));
    });
    const relatedObjects = tickets.map((ticket) => {
      const rows2 = ticket.originalReadSet.map((row2) => `${row2.table}:${row2.rowId}`);
      return rows2.length > 0 ? `${ticket.ticket}=${rows2.join(",")}` : "";
    }).filter((text) => text.length > 0).join(" | ");
    const promptLines = [
      "上一次操作有以下局部问题。其它成功操作已经保留，禁止重复输出或修改它们。",
      "逐条使用给定 ticket 修正原操作，每行一个 JSON 对象。",
      "只使用原本允许的操作。若无足够信息完成，输出同 ticket 的 noop，并用 why 说明。",
      "不要重新输出整个世界，不要改用 SQL，不要编造不存在的引用或证据。",
      `本批允许操作：${ctx.allowedOps.length > 0 ? ctx.allowedOps.join(", ") : "（无）"}`,
      "失败票据、原操作、准确错误：",
      ...ticketLines,
      `相关对象：${relatedObjects.length > 0 ? relatedObjects : "（本批未附读取集）"}`,
      "相关来源/机会：（由调用方在 repairSources 段补入，本批未附）",
      "示例：",
      '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}'
    ];
    return { batchId, tickets, issues: [], promptLines };
  }
  function mergeRepair(original, repaired, tickets, ctx) {
    const originals = Array.isArray(original) ? original : [];
    const entries = Array.isArray(repaired) ? repaired : [];
    const ticketList = Array.isArray(tickets) ? tickets : [];
    const limit = ATLAS_RUNTIME_LIMITS.repairAttemptsPerBatch;
    const attemptsUsed = typeof ctx.attemptsUsed === "number" && Number.isFinite(ctx.attemptsUsed) ? ctx.attemptsUsed : 0;
    if (attemptsUsed >= limit) {
      return {
        operations: originals,
        issues: [
          makeIssue3(
            "REPAIR_ATTEMPTS_EXHAUSTED",
            "$.ticket",
            `每批最多 ${limit} 次定向修复，本批已使用 ${attemptsUsed} 次；拒绝再次修复，保留原操作与原始 opId。`,
            "error",
            false
          )
        ],
        consumedTickets: [],
        exceededScope: false
      };
    }
    const ticketById = /* @__PURE__ */ new Map();
    for (const ticket of ticketList) {
      if (ticket && typeof ticket.ticket === "string" && !ticketById.has(ticket.ticket)) {
        ticketById.set(ticket.ticket, ticket);
      }
    }
    const knownTickets = [...ticketById.keys()];
    const originalById = /* @__PURE__ */ new Map();
    for (const op of originals) {
      if (op && typeof op.opId === "string" && !originalById.has(op.opId)) originalById.set(op.opId, op);
    }
    const allowedAliases = /* @__PURE__ */ new Map();
    for (const [ticketId, ticket] of ticketById) {
      const originalOp = originalById.get(ticket.originalOpId);
      allowedAliases.set(ticketId, new Set(originalOp ? collectNewAliases([originalOp]) : []));
    }
    const issues = [];
    const usedTickets = /* @__PURE__ */ new Set();
    const consumedTickets = [];
    const replacements = /* @__PURE__ */ new Map();
    let exceededScope = false;
    for (const entry of entries) {
      const line = typeof entry?.line === "number" ? entry.line : void 0;
      const model = entry?.value;
      const ticketId = typeof model?.ticket === "string" ? model.ticket.trim() : "";
      if (ticketId.length === 0) {
        issues.push(
          makeIssue3(
            "REPAIR_TICKET_UNKNOWN",
            "$.ticket",
            `修复条目缺少 ticket（第 ${line ?? "?"} 行）；本批票据：${knownTickets.join("、") || "（无）"}。没有票据无法映射回原 opId，该条被拒绝。`,
            "error",
            false,
            { line, opId: entry?.opId }
          )
        );
        continue;
      }
      const ticket = ticketById.get(ticketId);
      if (!ticket) {
        issues.push(
          makeIssue3(
            "REPAIR_TICKET_UNKNOWN",
            "$.ticket",
            `未知票据「${ticketId}」（第 ${line ?? "?"} 行）；本批票据只有：${knownTickets.join("、") || "（无）"}。该条被拒绝，其它合法修复条目保留。`,
            "error",
            false,
            { line, opId: entry?.opId }
          )
        );
        continue;
      }
      const originalOp = originalById.get(ticket.originalOpId);
      if (!originalOp) {
        issues.push(
          makeIssue3(
            "REPAIR_TICKET_UNKNOWN",
            "$.ticket",
            `票据「${ticketId}」指向的 originalOpId「${ticket.originalOpId}」不在本批原操作中（第 ${line ?? "?"} 行）；无法映射回原 opId，该条被拒绝。`,
            "error",
            false,
            { line, opId: entry?.opId }
          )
        );
        continue;
      }
      if (usedTickets.has(ticketId)) {
        issues.push(
          makeIssue3(
            "REPAIR_DUPLICATE_TICKET",
            "$.ticket",
            `票据「${ticketId}」在本批被重复修复（第 ${line ?? "?"} 行）；第二份被拒绝，不重复应用、不创建新 ID。`,
            "error",
            false,
            { line, opId: originalOp.opId }
          )
        );
        continue;
      }
      const opName = typeof model?.op === "string" ? model.op : "";
      if (opName === "noop") {
        usedTickets.add(ticketId);
        consumedTickets.push(ticketId);
        const why = oneLine(typeof model?.why === "string" ? model.why : "");
        issues.push(
          makeIssue3(
            "REPAIR_DECLINED",
            "$.why",
            `票据「${ticketId}」由模型输出 noop 表示无法完成：${why.length > 0 ? why : "（未给出 why）"}。原失败操作 ${ticket.originalOpId} 保持未解决。`,
            "warning",
            false,
            { line, opId: originalOp.opId }
          )
        );
        continue;
      }
      if (!ticket.allowedOps.includes(opName)) {
        exceededScope = true;
        issues.push(
          makeIssue3(
            "REPAIR_SCOPE_VIOLATION",
            "$.op",
            `票据「${ticketId}」以操作「${opName}」修复，超出该票据允许的操作集合：${ticket.allowedOps.length > 0 ? ticket.allowedOps.join("、") : "（无）"}。该条被拒绝，其它合法修复条目保留。`,
            "error",
            false,
            { line, opId: originalOp.opId }
          )
        );
        continue;
      }
      const allowed = allowedAliases.get(ticketId) ?? /* @__PURE__ */ new Set();
      const illegalAlias = collectNewAliases([entry]).find((alias) => !allowed.has(alias));
      if (illegalAlias !== void 0) {
        exceededScope = true;
        issues.push(
          makeIssue3(
            "REPAIR_SCOPE_VIOLATION",
            "$.ref",
            `票据「${ticketId}」引入了原依赖集合之外的新别名 new:${illegalAlias}；该票据只允许 ${[...allowed].map((alias) => `new:${alias}`).join("、") || "（没有任何 new: 别名）"}。新增辅助对象只能落在该票据原依赖集合内，该条被拒绝。`,
            "error",
            false,
            { line, opId: originalOp.opId }
          )
        );
        continue;
      }
      replacements.set(originalOp.opId, {
        opId: originalOp.opId,
        line: originalOp.line,
        rawHash: entry?.rawHash ? entry.rawHash : originalOp.rawHash,
        value: model
      });
      usedTickets.add(ticketId);
      consumedTickets.push(ticketId);
    }
    const operations = originals.map((op) => replacements.get(op.opId) ?? op);
    return { operations, issues, consumedTickets, exceededScope };
  }

  // src/atlas-ops-prompts.ts
  var FORMAT_SEGMENT = [
    "你负责 Atlas 的本次状态任务。",
    "只输出本次允许的操作，每行一个完整 JSON 对象。",
    "只写发生变化的字段。已有对象使用提供的短引用；新对象使用 new: 临时引用。",
    "不要输出整份世界、SQL、解释段或思考过程。",
    '没有需要修改的数据时输出 {"op":"noop"}。',
    "未知信息省略或在允许清空时写 null；不知道精确坐标时保留粗粒度地点。",
    "不要把人物的愿望当作已经发生的行动，也不要把某地有传言当作人人知情。",
    "可选 source 使用给定的来源编号；不需要逐字摘录 quote。",
    "格式示例：",
    '{"op":"character.upsert","ref":"C1","data":{"thought":"先观察。"}}',
    "本次允许的操作与最少参数：",
    "{{allowedOperationHelp}}"
  ].join("\n");
  var MINIMUM_HELP = {
    "location.upsert": "新建 name；修改 ref + 至少一个变更字段",
    "character.upsert": "新建 name + 身份/重要性线索之一；候选只需 name（registration=watch）；修改 ref",
    "item.upsert": "新建 name；修改 ref",
    "item.transfer": "ref + to（holder_ref / container_ref / location_ref / unknown 四选一）",
    "faction.upsert": "新建 name；修改 ref",
    "relation.upsert": "subject_ref, object_ref, label",
    "plan.propose": "actor_ref, goal, steps",
    "plan.revise": "ref, change(pause/cancel/resume/replace_future)",
    "event.propose": "title, phase(scheduled/observed/simulated)",
    "information.propose": "content",
    "attention.propose": "opportunity_ref, belief",
    "channel.upsert": "owner_ref, kind, name",
    "map.estimate": "ref + 尺寸或距离依据",
    "route.propose": "from_ref, to_ref",
    noop: "无修改"
  };
  var PHASE_TASK = {
    observe: [
      "任务：从本轮已完成正文提取实际变化。不要续写故事。",
      "识别有重要身份/实质世界书资料的人物，允许首楼建档；一闪而过的有名路人用character.upsert加registration=watch报告候选，完全无关无名群众不建档。",
      "每轮主动判断唯一主角当前实际所在地点；正文代词承接上文且唯一指向已到达地点时也更新 location_ref。意图、梦境、回忆、远方镜头不算抵达。",
      "地点包含关系、人物粗位置与精确坐标分开处理。学校内但教室未知，就只给学校引用。",
      "心理/倾向可以依据人物设定合理更新，并保持简短。",
      "已完成行为或明确耗时可以放在 event.propose 的 activity/time_hint 中，未完成计划不算已经经过时间。"
    ],
    geography: [
      "任务：处理这一张地图的层级、范围标定或路线估计。",
      "城内地点归入城市子图，周边地点通过实际邻接/路线表达。移动载具不当作固定建筑。",
      "先根据给定资料判断地图大致现实尺寸；信息不足时给合理估计范围并说明 why，不能声称精确测量。",
      "不要利用界面标签排版坐标推出真实距离。用户已锁定的标定不修改。"
    ],
    decision: [
      "任务：为下面列出的角色判断注意、相信和下一步意图。",
      "每个角色按自己的知情记录行动。不要把其他角色或作者才知道的秘密当成他的知识。",
      "可接受已有后台活动、准备、停留、改道和新计划；不要直接写已抵达或跳过准备。",
      "只能对给定 opportunity_ref 判断是否注意/相信。没有接触机会不能让人物凭空获知消息。",
      "地图上的估计路线可以作为计划，精确路中坐标由程序计算。"
    ],
    outcome: [
      "任务：判断已经满足基本时空条件的行动会产生什么结果。",
      "给出事件和有限效果建议；失败、部分成功或意外停留都允许。",
      "后台可以发生真实后果，不需要主角出现在场。",
      "不要重复准备/旅行尚未完成的动作；不要给已死亡者继续安排不适用的主动行动。",
      "用 event.propose，并把关联行动写入 action_ref；必要的角色状态/物品转移放进同一事件的 effects。"
    ],
    repair: [
      "上一次操作有以下局部问题。其它成功操作已经保留，禁止重复输出或修改它们。",
      "逐条使用给定 ticket 修正原操作，每行一个完整 JSON 对象。",
      "只使用原本允许的操作。若无足够信息完成，输出同 ticket 的 noop，并用 why 说明。",
      "不要重新输出整个世界，不要改用 SQL，不要编造不存在的引用或证据。",
      "示例：",
      '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}'
    ]
  };
  function allowedOperationHelp(allowedOps) {
    return allowedOps.map((op) => `- ${op}：${MINIMUM_HELP[op] ?? ""}`).join("\n");
  }
  function buildStagePrompt(input) {
    const allowedOps = input.allowedOps ?? allowedOpsForPhase(input.phase);
    const system = [FORMAT_SEGMENT.replace("{{allowedOperationHelp}}", allowedOperationHelp(allowedOps))];
    if (input.userPresetSegment) system.push(input.userPresetSegment);
    const user = [...PHASE_TASK[input.phase] ?? []];
    if (input.phase === "observe") {
      user.push(`现有对象短引用：${(input.entityRefs ?? []).join("、") || "（无）"}`);
      user.push(`相关世界书：${(input.lorebookSources ?? []).join("、") || "（无）"}`);
      user.push(`本轮用户行动：${input.userSource ?? ""}`);
      user.push(`本轮正文：${input.assistantSource ?? ""}`);
    } else if (input.phase === "decision") {
      user.push(`本轮可用时间与时刻：${input.timeWindow ?? ""}`);
      user.push(`待判断角色及各自认知：${input.actorSlices ?? ""}`);
      user.push(`当前行动和行程：${input.activeActions ?? ""}`);
      user.push(`程序给出的接触机会：${input.opportunities ?? ""}`);
    } else if (input.phase === "outcome") {
      user.push(`行动：${input.dueActions ?? ""}`);
      user.push(`现场实际状态及相关能力：${input.relevantWorldFacts ?? ""}`);
      user.push(`时间/路程/资源检查结果：${input.eligibility ?? ""}`);
    } else if (input.phase === "geography") {
      user.push(`本图：${input.mapScope ?? ""}`);
      user.push(`现有地点与关系：${input.geoEntities ?? ""}`);
      user.push(`地理依据：${input.geoSources ?? ""}`);
      user.push(`本次具体缺项：${input.geoMissing ?? ""}`);
    } else if (input.phase === "repair") {
      user.push(`失败票据、原操作、准确错误：${input.repairTickets ?? ""}`);
      user.push(`相关对象：${input.repairRefs ?? ""}`);
      user.push(`相关来源/机会：${input.repairSources ?? ""}`);
    }
    return {
      batchId: input.batchId ?? `${input.phase}_batch`,
      phase: input.phase,
      messages: [
        { role: "system", content: system.join("\n\n") },
        { role: "user", content: user.join("\n") }
      ],
      allowedOps,
      anchor: {
        chatUid: "",
        branchId: "",
        parentTurnId: null,
        hostMessageUid: "",
        variantKey: "",
        baseRevision: 0,
        baseStorageRevision: 0,
        inputHash: ""
      },
      maxTokens: input.maxTokens ?? (input.phase === "repair" ? ATLAS_RUNTIME_LIMITS.repairResponseTokens : ATLAS_RUNTIME_LIMITS.normalResponseTokens),
      timeoutMs: input.timeoutMs ?? ATLAS_RUNTIME_LIMITS.modelTimeoutMs,
      repairOfBatchId: input.repairOfBatchId
    };
  }

  // src/atlas-db-envelope.ts
  var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function bytesToBase64(bytes) {
    const B = globalThis.Buffer;
    if (typeof B !== "undefined") {
      return B.from(bytes).toString("base64");
    }
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64_ALPHABET[b0 >> 2];
      out += B64_ALPHABET[(b0 & 3) << 4 | b1 >> 4];
      out += i + 1 < bytes.length ? B64_ALPHABET[(b1 & 15) << 2 | b2 >> 6] : "=";
      out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : "=";
    }
    return out;
  }
  var HEX = "0123456789abcdef";
  function toHex(bytes) {
    let out = "";
    for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
    return out;
  }
  function utf8Bytes(text) {
    return new TextEncoder().encode(text);
  }
  function sha256HexSync(bytes) {
    if (typeof bytes === "string") return stableHexHash(bytes);
    let text = "";
    for (const b of bytes) text += String.fromCharCode(b);
    return stableHexHash(text);
  }
  async function sha256Hex4(bytes) {
    const data = typeof bytes === "string" ? utf8Bytes(bytes) : bytes;
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digestInput = new Uint8Array(data.length);
      digestInput.set(data);
      const digest = await subtle.digest("SHA-256", digestInput);
      return toHex(new Uint8Array(digest));
    }
    return sha256HexAsyncNode(data);
  }
  async function sha256HexAsyncNode(data) {
    return sha256HexSync(data);
  }
  async function encodeSnapshot(bytes, identity) {
    if (!(bytes instanceof Uint8Array)) {
      throw new AtlasDbError("ENVELOPE_BYTES_REQUIRED", "encodeSnapshot 需要 Uint8Array（不能把导出结果 JSON.stringify 成数字对象）", {
        received: typeof bytes
      });
    }
    const schemaVersion = identity.schemaVersion ?? ATLAS_SCHEMA_VERSION;
    if (schemaVersion !== ATLAS_SCHEMA_VERSION) {
      throw new AtlasDbError("ENVELOPE_SCHEMA_UNSUPPORTED", `拒绝生成 schema_version=${schemaVersion} 的存档（本实现为 ${ATLAS_SCHEMA_VERSION}）`, {
        schemaVersion,
        supported: ATLAS_SCHEMA_VERSION
      });
    }
    const sha = await sha256Hex4(bytes);
    return {
      format: "atlas-sqlite",
      storage_version: 1,
      chat_uid: identity.chatUid,
      world_uid: identity.worldUid,
      storage_revision: identity.storageRevision,
      active_branch_id: identity.activeBranchId,
      schema_version: schemaVersion,
      encoding: "sqlite-base64",
      byte_length: bytes.length,
      sha256: sha,
      data: bytesToBase64(bytes),
      assets: identity.assets ?? []
    };
  }

  // src/atlas-db-outbox.ts
  function enqueueProjectionSync(db, input) {
    const issues = [];
    const idempotencyKey = `${input.branchId}:${input.projectionScope}:${input.targetRevision}:${input.payloadHash}`;
    const existing = queryBound(db, "SELECT id, status FROM sync_outbox WHERE idempotency_key = ? LIMIT 1", [idempotencyKey]);
    if (existing.length > 0) {
      return { enqueued: false, taskId: String(existing[0].id), superseded: [], issues };
    }
    const stale = queryBound(
      db,
      `SELECT id FROM sync_outbox WHERE branch_id = ? AND status IN ('pending','running','failed') AND target_revision < ?`,
      [input.branchId, input.targetRevision]
    );
    const superseded = [];
    for (const row2 of stale) {
      const id = String(row2.id);
      runBound(db, `UPDATE sync_outbox SET status = 'superseded', completed_wall_ms = ? WHERE id = ?`, [input.nowWallMs, id]);
      superseded.push(id);
    }
    const taskId = input.makeId(idempotencyKey);
    runBound(
      db,
      `INSERT INTO sync_outbox (id, branch_id, requested_by_turn_id, target, projection_scope, target_revision, idempotency_key, payload_hash, status, attempt_count, created_wall_ms)
     VALUES (?, ?, ?, 'managed_lorebook', ?, ?, ?, ?, 'pending', 0, ?)`,
      [taskId, input.branchId, input.turnId, input.projectionScope, input.targetRevision, idempotencyKey, input.payloadHash, input.nowWallMs]
    );
    return { enqueued: true, taskId, superseded, issues };
  }
  function projectionHash(payload) {
    return sha256HexSync(stableStringify(payload));
  }
  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }

  // src/atlas-db-readport.ts
  function pkColumns(table) {
    if (table === "branches" || table === "turns" || table === "turn_changes" || table === "sync_outbox") return ["id"];
    return ["branch_id", "id"];
  }
  function createTableReadPort(db) {
    return {
      selectOne(table, branchId, id) {
        if (!isKnownTable(table)) return null;
        const pks = pkColumns(table);
        const where = pks.map((c) => `${c} = ?`).join(" AND ");
        const params = pks.includes("branch_id") ? [branchId, id] : [id];
        const rows2 = queryBound(db, `SELECT * FROM ${table} WHERE ${where} LIMIT 1`, params);
        if (rows2.length === 0) return null;
        const decoded = decodeRow(table, rows2[0], { allowExtra: true });
        if (!decoded.ok) throw new Error(`READ_DECODE_FAILED: ${table}: ${decoded.issues.map((i) => i.path).join(",")}`);
        const row2 = decoded.row;
        if (pks.includes("branch_id")) row2.branch_id = branchId;
        return row2;
      },
      selectWhere(table, where, limit = 200) {
        if (!isKnownTable(table)) return [];
        const clauses = [];
        const params = [];
        for (const [key, value] of Object.entries(where)) {
          if (!tableColumnNames(table).includes(key)) continue;
          if (value === null) {
            clauses.push(`${key} IS NULL`);
          } else if (typeof value === "boolean") {
            clauses.push(`${key} = ?`);
            params.push(value ? 1 : 0);
          } else if (typeof value === "number" || typeof value === "string") {
            clauses.push(`${key} = ?`);
            params.push(value);
          } else if (Array.isArray(value)) {
            if (value.length === 0) {
              clauses.push("0");
              continue;
            }
            clauses.push(`${key} IN (${value.map(() => "?").join(",")})`);
            for (const v of value) params.push(v);
          } else {
            continue;
          }
        }
        const sql = `SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ${tableColumnNames(table).includes("branch_id") ? "branch_id, " : ""}id ASC LIMIT ${Math.max(1, Math.min(1e3, limit))}`;
        const rows2 = queryBound(db, sql, params);
        return rows2.map((row2) => {
          const decoded = decodeRow(table, row2, { allowExtra: true });
          if (!decoded.ok) throw new Error(`READ_DECODE_FAILED: ${table}: ${decoded.issues.map((i) => i.path).join(",")}`);
          return decoded.row;
        });
      }
    };
  }

  // src/atlas-sim-position.ts
  function row(db, table, branchId, id) {
    const rows2 = queryBound(db, `SELECT * FROM ${table} WHERE branch_id = ? AND id = ? LIMIT 1`, [branchId, id]);
    if (rows2.length === 0) return null;
    const decoded = decodeRow(table, rows2[0], { allowExtra: true });
    return decoded.ok ? decoded.row : null;
  }
  function openJourneyOf(world, entityId) {
    const rows2 = queryBound(
      world.db,
      `SELECT * FROM journeys WHERE branch_id = ? AND mover_entity_id = ? AND status IN ('moving','paused','blocked') LIMIT 1`,
      [world.branchId, entityId]
    );
    if (rows2.length === 0) return null;
    const decoded = decodeRow("journeys", rows2[0], { allowExtra: true });
    return decoded.ok ? decoded.row : null;
  }
  function isKnownEntity(world, entityId) {
    const rows2 = queryBound(world.db, "SELECT kind FROM entity_keys WHERE branch_id = ? AND id = ? LIMIT 1", [world.branchId, entityId]);
    return rows2.length > 0;
  }
  var MAX_CHAIN = ATLAS_RUNTIME_LIMITS.containerDepth;
  function resolveEffectivePosition(world, entityId, _atTime, cache) {
    const visited = /* @__PURE__ */ new Set();
    let cursor = entityId;
    let depth = 0;
    while (cursor && depth <= MAX_CHAIN) {
      if (visited.has(cursor)) return { kind: "unknown" };
      visited.add(cursor);
      depth += 1;
      const item = pickRow(world, cache, "items", cursor);
      if (item) {
        const holder = item.holder_character_id ? String(item.holder_character_id) : null;
        const container = item.container_item_id ? String(item.container_item_id) : null;
        if (holder) {
          cursor = holder;
          continue;
        }
        if (container) {
          cursor = container;
          continue;
        }
      }
      const character = pickRow(world, cache, "characters", cursor);
      if (character) {
        const journey = pickOpenJourney(world, cache, cursor);
        if (journey && String(journey.status) === "moving") {
          return {
            kind: "in_transit",
            journeyId: String(journey.id),
            fromId: journey.last_reached_location_id ? String(journey.last_reached_location_id) : String(journey.origin_location_id),
            toId: String(journey.destination_location_id),
            routePosition: typeof journey.segment_distance_done_m === "number" ? journey.segment_distance_done_m : null,
            quality: String(journey.position_quality ?? "unlocated")
          };
        }
        if (journey && ["paused", "blocked"].includes(String(journey.status)) && journey.stop_location_id) {
          return { kind: "at_location", locationId: String(journey.stop_location_id), precision: "coarse" };
        }
        const location2 = character.location_id ? String(character.location_id) : null;
        if (location2) {
          const vehicleVisited = new Set(visited);
          vehicleVisited.delete(cursor);
          vehicleVisited.delete(entityId);
          const nested = resolveVehicleChain(world, location2, vehicleVisited, cache);
          if (nested) return nested;
          return { kind: "at_location", locationId: location2, precision: "coarse" };
        }
        const grid = gridOf(character);
        if (grid) return grid;
        return { kind: "unknown" };
      }
      const location = pickRow(world, cache, "locations", cursor);
      if (location) {
        const journey = pickOpenJourney(world, cache, cursor);
        if (journey && String(journey.status) === "moving") {
          return {
            kind: "in_transit",
            journeyId: String(journey.id),
            fromId: journey.last_reached_location_id ? String(journey.last_reached_location_id) : String(journey.origin_location_id),
            toId: String(journey.destination_location_id),
            routePosition: typeof journey.segment_distance_done_m === "number" ? journey.segment_distance_done_m : null,
            quality: String(journey.position_quality ?? "unlocated")
          };
        }
        const grid = gridOf(location);
        if (grid) return grid;
        const anchor = location.anchor_location_id ? String(location.anchor_location_id) : null;
        if (anchor) {
          const anchorRow = row(world.db, "locations", world.branchId, anchor);
          if (anchorRow) {
            const anchorGrid = gridOf(anchorRow);
            if (anchorGrid) return anchorGrid;
            return { kind: "at_location", locationId: anchor, precision: "coarse" };
          }
        }
        const parent = location.parent_location_id ? String(location.parent_location_id) : null;
        if (parent) {
          const inherited = resolveStaticLocationPosition(world, parent, /* @__PURE__ */ new Set([cursor]), cache);
          if (inherited) return inherited;
        }
        return { kind: "at_location", locationId: cursor, precision: "coarse" };
      }
      if (!isKnownEntityCached(world, cache, cursor)) return { kind: "unknown" };
      return { kind: "unknown" };
    }
    return { kind: "unknown" };
  }
  function resolveVehicleChain(world, locationId, visited, cache) {
    if (visited.has(locationId)) return null;
    visited.add(locationId);
    const location = pickRow(world, cache, "locations", locationId);
    const journey = pickOpenJourney(world, cache, locationId);
    if (!journey) {
      const parent = location?.parent_location_id ? String(location.parent_location_id) : null;
      if (!parent) return null;
      return resolveVehicleChain(world, parent, visited, cache);
    }
    if (String(journey.status) === "moving") {
      return {
        kind: "in_transit",
        journeyId: String(journey.id),
        fromId: journey.last_reached_location_id ? String(journey.last_reached_location_id) : String(journey.origin_location_id),
        toId: String(journey.destination_location_id),
        routePosition: typeof journey.segment_distance_done_m === "number" ? journey.segment_distance_done_m : null,
        quality: String(journey.position_quality ?? "unlocated")
      };
    }
    return null;
  }
  function resolveStaticLocationPosition(world, locationId, seen, cache) {
    if (seen.has(locationId)) return null;
    seen.add(locationId);
    const location = pickRow(world, cache, "locations", locationId);
    if (!location) return null;
    const grid = gridOf(location);
    if (grid) return grid;
    const parent = location.parent_location_id ? String(location.parent_location_id) : null;
    if (parent) return resolveStaticLocationPosition(world, parent, seen, cache);
    return null;
  }
  function gridOf(entity) {
    const mapId = entity.map_id ? String(entity.map_id) : null;
    const x = typeof entity.grid_x === "number" ? entity.grid_x : null;
    const y = typeof entity.grid_y === "number" ? entity.grid_y : null;
    if (!mapId || x === null || y === null) return null;
    const precision = String(entity.coord_precision ?? "unknown");
    if (precision === "unknown") return null;
    return {
      kind: "at_grid",
      mapId,
      x,
      y,
      precision,
      radius: typeof entity.uncertainty_radius_cells === "number" ? entity.uncertainty_radius_cells : null
    };
  }
  function pickRow(world, cache, table, id) {
    const bucket = cache?.[table];
    if (bucket) return bucket.get(id) ?? null;
    return row(world.db, table, world.branchId, id);
  }
  function pickOpenJourney(world, cache, entityId) {
    if (cache?.journeyByMover) return cache.journeyByMover.get(entityId) ?? null;
    return openJourneyOf(world, entityId);
  }
  function isKnownEntityCached(world, cache, entityId) {
    if (cache && (cache.items || cache.characters || cache.locations)) {
      return Boolean(cache.items?.has(entityId) || cache.characters?.has(entityId) || cache.locations?.has(entityId));
    }
    return isKnownEntity(world, entityId);
  }
  function buildPositionCache(world) {
    const toMap = (table) => {
      const out = /* @__PURE__ */ new Map();
      for (const raw of queryBound(world.db, `SELECT * FROM ${table} WHERE branch_id = ?`, [world.branchId])) {
        const decoded = decodeRow(table, raw, { allowExtra: true });
        const rowValue = decoded.ok ? decoded.row : raw;
        out.set(String(rowValue.id), rowValue);
      }
      return out;
    };
    const journeyByMover = /* @__PURE__ */ new Map();
    for (const raw of queryBound(
      world.db,
      `SELECT * FROM journeys WHERE branch_id = ? AND status IN ('moving','paused','blocked')`,
      [world.branchId]
    )) {
      const decoded = decodeRow("journeys", raw, { allowExtra: true });
      const rowValue = decoded.ok ? decoded.row : raw;
      const mover = String(rowValue.mover_entity_id ?? "");
      if (mover && !journeyByMover.has(mover)) journeyByMover.set(mover, rowValue);
    }
    return { items: toMap("items"), characters: toMap("characters"), locations: toMap("locations"), journeyByMover };
  }

  // src/atlas-scale.ts
  function finitePositiveNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    return value;
  }
  var SCALE_BAR_FIXED_PX = 96;
  var SCALE_BAR_FIXED_MIN_PX = 64;
  var SCALE_BAR_FIXED_INSET_PX = 48;
  function formatScaleReading(value) {
    if (!Number.isFinite(value) || value <= 0) return "";
    return String(Number(value.toPrecision(3)));
  }
  function formatFixedScaleDistance(meters) {
    if (!Number.isFinite(meters) || meters <= 0) return "";
    if (meters < 1e-3) return `${formatScaleReading(meters * 1e3)} 毫米`;
    if (meters < 1) return `${formatScaleReading(meters * 100)} 厘米`;
    if (meters < 1e3) return `${formatScaleReading(meters)} 米`;
    return `${formatScaleReading(meters / 1e3)} 千米`;
  }
  function computeViewportScaleBar(input) {
    const cameraK = finitePositiveNumber(input.cameraK);
    if (cameraK === null) return null;
    const width = typeof input.viewportWidth === "number" && Number.isFinite(input.viewportWidth) && input.viewportWidth > 0 ? input.viewportWidth : null;
    const barWidthPx = width === null ? SCALE_BAR_FIXED_PX : Math.max(SCALE_BAR_FIXED_MIN_PX, Math.min(SCALE_BAR_FIXED_PX, width - SCALE_BAR_FIXED_INSET_PX));
    const metersPerCell = finitePositiveNumber(input.metersPerCell ?? null);
    if (metersPerCell === null) {
      const distanceCells2 = barWidthPx / cameraK;
      return {
        barWidthPx,
        distanceMeters: null,
        distanceCells: distanceCells2,
        unitMode: "cells",
        label: `约 ${formatScaleReading(distanceCells2)} 格 · 未标定`,
        ariaLabel: `屏幕 ${Math.round(barWidthPx)} 像素约等于 ${formatScaleReading(distanceCells2)} 格（本图未标定比例尺）`
      };
    }
    const distanceMeters = barWidthPx * metersPerCell / cameraK;
    const distanceCells = barWidthPx / cameraK;
    const reading = formatFixedScaleDistance(distanceMeters);
    return {
      barWidthPx,
      distanceMeters,
      distanceCells,
      unitMode: "meters",
      label: reading,
      ariaLabel: `屏幕 ${Math.round(barWidthPx)} 像素约等于 ${reading}`
    };
  }

  // src/atlas-db-views.ts
  function rows(ctx, table, where = "", params = [], limit = 500) {
    const hasBranch = table !== "branches" && table !== "turns" && table !== "turn_changes" && table !== "sync_outbox";
    const clauses = [];
    const values = [];
    if (hasBranch) {
      clauses.push("branch_id = ?");
      values.push(ctx.branchId);
    }
    if (where) {
      clauses.push(where);
      values.push(...params);
    }
    const sql = `SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} LIMIT ${Math.max(1, Math.min(2e3, limit))}`;
    return queryBound(ctx.db, sql, values).map((raw) => {
      const decoded = decodeRow(table, raw, { allowExtra: true });
      return decoded.ok ? decoded.row : raw;
    });
  }
  function clampRevision(ctx, requested) {
    if (requested === void 0 || requested === null) return { ok: true, current: ctx.revision };
    return { ok: requested === ctx.revision, requested, current: ctx.revision };
  }
  function staleResult(ctx, requested) {
    const rev = clampRevision(ctx, requested);
    if (rev.ok) return null;
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [],
      metadata: { stale: true, requestedRevision: rev.requested, currentRevision: rev.current }
    };
  }
  function queryMapView(ctx, query) {
    const stale = staleResult(ctx, query.revision);
    if (stale) return stale;
    const maps = rows(ctx, "maps", "", [], 200).filter((m) => String(m.status) === "active");
    if (maps.length === 0) {
      return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { empty: true, reason: "NO_MAP" } };
    }
    const selected = query.mapId ? maps.filter((m) => String(m.id) === query.mapId) : maps;
    const mapIds = new Set(selected.map((m) => String(m.id)));
    const locations = rows(ctx, "locations", "status = 'active'", [], 2e3);
    const locationById = new Map(locations.map((l) => [String(l.id), l]));
    const characters = rows(ctx, "characters", "status = 'active'", [], 2e3);
    const itemRows = rows(ctx, "items", "status = 'active'", [], 2e3);
    const routes = rows(ctx, "routes", "", [], 1e3);
    const positionCache = buildPositionCache({ db: ctx.db, branchId: ctx.branchId });
    const items = selected.map((map) => {
      const mapId = String(map.id);
      const points = [];
      const coarseList = [];
      for (const loc of locations) {
        const locId = String(loc.id);
        const locMap = loc.map_id ? String(loc.map_id) : null;
        if (locMap !== mapId) continue;
        const precision = String(loc.coord_precision ?? "unknown");
        if (precision === "unknown" || typeof loc.grid_x !== "number" || typeof loc.grid_y !== "number") continue;
        points.push({
          entityId: locId,
          kind: "location",
          name: String(loc.name ?? ""),
          mapId,
          x: loc.grid_x,
          y: loc.grid_y,
          precision,
          radius: typeof loc.uncertainty_radius_cells === "number" ? loc.uncertainty_radius_cells : null,
          markerQuality: precision
        });
      }
      for (const ch of characters) {
        const chId = String(ch.id);
        const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, chId, void 0, positionCache);
        if (position.kind === "at_grid" && position.mapId === mapId) {
          points.push({
            entityId: chId,
            kind: "character",
            name: String(ch.name ?? ""),
            mapId,
            x: position.x,
            y: position.y,
            precision: position.precision,
            radius: position.radius ?? null,
            markerQuality: position.precision
          });
        } else if (position.kind === "at_location") {
          const loc = locationById.get(position.locationId);
          const locMap = loc?.map_id ? String(loc.map_id) : null;
          if (locMap === mapId && typeof ch.grid_x === "number" && typeof ch.grid_y === "number" && String(ch.coord_precision) !== "unknown") {
            points.push({
              entityId: chId,
              kind: "character",
              name: String(ch.name ?? ""),
              mapId,
              x: ch.grid_x,
              y: ch.grid_y,
              precision: String(ch.coord_precision),
              radius: typeof ch.uncertainty_radius_cells === "number" ? ch.uncertainty_radius_cells : null,
              markerQuality: String(ch.coord_precision)
            });
            continue;
          }
          if (locMap === mapId) {
            coarseList.push({
              entityId: chId,
              name: String(ch.name ?? ""),
              locationId: position.locationId,
              locationName: loc ? String(loc.name ?? "") : null
            });
          }
        }
      }
      for (const item of itemRows) {
        const itemId = String(item.id);
        if (item.holder_character_id || item.container_item_id) continue;
        const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, itemId, void 0, positionCache);
        if (position.kind === "at_grid" && position.mapId === mapId) {
          points.push({
            entityId: itemId,
            kind: "item",
            name: String(item.name ?? ""),
            mapId,
            x: position.x,
            y: position.y,
            precision: position.precision,
            radius: position.radius ?? null,
            markerQuality: position.precision
          });
        }
      }
      const mapRoutes = routes.filter((r) => r.map_id ? String(r.map_id) === mapId : false).map((r) => ({
        routeId: String(r.id),
        fromId: String(r.from_location_id),
        toId: String(r.to_location_id),
        kind: String(r.kind),
        geometryQuality: String(r.geometry_quality ?? "unknown"),
        distanceM: typeof r.distance_m === "number" ? r.distance_m : null,
        dashed: String(r.geometry_quality) !== "confirmed",
        allowedModes: Array.isArray(r.allowed_modes_json) ? r.allowed_modes_json : []
      }));
      const metersPerCell = typeof map.meters_per_cell === "number" ? map.meters_per_cell : null;
      return {
        mapId,
        name: String(map.name ?? ""),
        kind: String(map.kind ?? "world"),
        containerLocationId: map.container_location_id ? String(map.container_location_id) : null,
        metersPerCell,
        scaleQuality: String(map.scale_quality ?? "uncalibrated"),
        scaleLocked: Number(map.scale_locked ?? 0) === 1,
        calibrationRev: Number(map.calibration_rev ?? 1),
        defaultTerrain: String(map.default_terrain ?? "unknown"),
        points,
        coarseList,
        routes: mapRoutes,
        frames: {
          frame: map.frame_json ?? {},
          scaleBar: metersPerCell === null ? null : computeViewportScaleBar({ cameraK: 40, metersPerCell })
        }
      };
    });
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items,
      metadata: {
        mapCount: mapIds.size,
        pointCount: items.reduce((n, m) => n + m.points.length, 0),
        coarseCount: items.reduce((n, m) => n + m.coarseList.length, 0),
        viewMode: ctx.viewMode ?? "author",
        ...assetDiagnostics(ctx, selected)
      }
    };
  }
  function assetDiagnostics(ctx, maps) {
    const present = new Set((ctx.assets ?? []).map((asset) => String(asset.key)));
    const referenced = [
      ...new Set(
        maps.map(
          (map) => map.background_asset_key === null || map.background_asset_key === void 0 ? "" : String(map.background_asset_key)
        ).filter((key) => key !== "")
      )
    ].sort();
    const missing = referenced.filter((key) => !present.has(key));
    const unreferenced = [...present].filter((key) => !referenced.includes(key)).sort();
    return {
      assetCheck: "ok",
      referencedAssetCount: referenced.length,
      missingAssets: missing,
      missingAssetCount: missing.length,
      unreferencedAssets: unreferenced,
      assetNotice: missing.length > 0 ? `缺底图：${missing.length} 张引用的底图未随存档带来（实体与坐标仍完整）` : null
    };
  }
  function queryNearby(ctx, query) {
    const stale = staleResult(ctx, query.revision);
    if (stale) return stale;
    const target = query.entityId ? resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, query.entityId) : { kind: "unknown" };
    if (target.kind === "unknown") {
      return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: "POSITION_UNKNOWN" } };
    }
    const here = target.kind === "at_grid" ? target.mapId : target.kind === "at_location" ? target.locationId : null;
    const characters = rows(ctx, "characters", "status = 'active'", [], 1e3);
    const results = [];
    for (const ch of characters) {
      const id = String(ch.id);
      if (query.entityId && id === query.entityId) continue;
      const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, id);
      if (target.kind === "at_grid" && position.kind === "at_grid" && position.mapId === here) {
        const dx = position.x - target.x;
        const dy = position.y - target.y;
        results.push({
          entityId: id,
          name: String(ch.name ?? ""),
          relevance: "same_map",
          positionQuality: position.precision,
          gridDistance: Math.sqrt(dx * dx + dy * dy)
        });
      } else if (target.kind === "at_location" && position.kind === "at_location" && position.locationId === here) {
        results.push({
          entityId: id,
          name: String(ch.name ?? ""),
          relevance: "same_location",
          positionQuality: "coarse"
        });
      }
    }
    const limit = query.limit ?? 50;
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: results.slice(0, limit),
      metadata: { anchor: target.kind, anchorId: here, total: results.length }
    };
  }
  function queryEntityDetail(ctx, query) {
    const stale = staleResult(ctx, query.revision);
    if (stale) return stale;
    const entityId = query.entityId;
    if (!entityId) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: "NO_ENTITY_ID" } };
    const key = rows(ctx, "entity_keys", "id = ?", [entityId], 1)[0];
    if (!key) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: "ENTITY_UNKNOWN" } };
    const kind = String(key.kind);
    if (kind === "character") {
      const character = rows(ctx, "characters", "id = ?", [entityId], 1)[0];
      if (!character) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: "ENTITY_UNKNOWN" } };
      const relations2 = rows(ctx, "relations", "subject_entity_id = ? OR object_entity_id = ?", [entityId, entityId], 200);
      const actions = rows(ctx, "actions", "actor_entity_id = ?", [entityId], 100);
      const journeys = rows(ctx, "journeys", "mover_entity_id = ?", [entityId], 20);
      const knowledge = rows(ctx, "knowledge", "knower_character_id = ?", [entityId], 200);
      const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, entityId);
      return {
        branchId: ctx.branchId,
        revision: ctx.revision,
        items: [{ kind, character, relations: relations2, actions, journeys, knowledge, position }],
        metadata: { counts: { relations: relations2.length, actions: actions.length, knowledge: knowledge.length } }
      };
    }
    if (kind === "location") {
      const location = rows(ctx, "locations", "id = ?", [entityId], 1)[0];
      if (!location) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: "ENTITY_UNKNOWN" } };
      const children = rows(ctx, "locations", "parent_location_id = ?", [entityId], 200);
      const present = rows(ctx, "characters", "location_id = ? AND status = ?", [entityId, "active"], 200);
      const events = rows(ctx, "events", "location_id = ?", [entityId], 200);
      const fronts = rows(ctx, "rumor_fronts", "location_id = ?", [entityId], 200);
      const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, entityId);
      return {
        branchId: ctx.branchId,
        revision: ctx.revision,
        items: [{ kind, location, children, present, events, fronts, position }],
        metadata: { counts: { children: children.length, present: present.length, events: events.length, fronts: fronts.length } }
      };
    }
    if (kind === "item") {
      const item = rows(ctx, "items", "id = ?", [entityId], 1)[0];
      if (!item) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: "ENTITY_UNKNOWN" } };
      const contained = rows(ctx, "items", "container_item_id = ?", [entityId], 200);
      const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, entityId);
      return { branchId: ctx.branchId, revision: ctx.revision, items: [{ kind, item, contained, position }], metadata: {} };
    }
    const faction = rows(ctx, "factions", "id = ?", [entityId], 1)[0];
    const relations = rows(ctx, "relations", "subject_entity_id = ? OR object_entity_id = ?", [entityId, entityId], 200);
    const channels = rows(ctx, "channels", "owner_entity_id = ?", [entityId], 100);
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [{ kind, faction, relations, channels }],
      metadata: { counts: { relations: relations.length, channels: channels.length } }
    };
  }
  function queryChanges(ctx, query) {
    const stale = staleResult(ctx, query.revision);
    if (stale) return stale;
    const limit = Math.max(1, Math.min(500, query.limit ?? 100));
    const changes = queryBound(
      ctx.db,
      `SELECT tc.id, tc.turn_id, tc.sequence, tc.group_id, tc.operation_id, tc.target_table, tc.target_row_id, tc.operation, tc.summary, tc.basis_json, t.kind AS turn_kind, t.created_wall_ms
     FROM turn_changes tc JOIN turns t ON t.id = tc.turn_id
     WHERE t.branch_id = ?
     ORDER BY tc.turn_id DESC, tc.sequence DESC LIMIT ?`,
      [ctx.branchId, limit]
    );
    const items = changes.map((c) => ({
      changeId: String(c.id),
      turnId: String(c.turn_id),
      sequence: Number(c.sequence),
      groupId: String(c.group_id),
      operationId: String(c.operation_id),
      table: String(c.target_table),
      rowId: String(c.target_row_id),
      operation: String(c.operation),
      summary: String(c.summary ?? ""),
      turnKind: String(c.turn_kind ?? ""),
      basis: safeJson(c.basis_json)
    }));
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items,
      metadata: { count: items.length, cursor: query.cursor ?? null }
    };
  }
  function safeJson(text) {
    if (typeof text !== "string") return {};
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return { parseError: true };
    }
  }
  function queryDiagnostics(ctx, query) {
    const stale = staleResult(ctx, query.revision);
    if (stale) return stale;
    const limit = Math.max(1, Math.min(500, query.limit ?? 100));
    const offset = query.cursor ? Number(query.cursor) : 0;
    const total = queryBound(
      ctx.db,
      `SELECT COUNT(*) AS n FROM turn_changes tc JOIN turns t ON t.id = tc.turn_id WHERE t.branch_id = ?`,
      [ctx.branchId]
    );
    const totalCount = Number(total[0]?.n ?? 0);
    const changes = queryBound(
      ctx.db,
      `SELECT tc.id, tc.turn_id, tc.group_id, tc.operation_id, tc.target_table, tc.target_row_id, tc.operation, tc.summary, tc.basis_json
     FROM turn_changes tc JOIN turns t ON t.id = tc.turn_id
     WHERE t.branch_id = ? ORDER BY tc.turn_id, tc.sequence LIMIT ? OFFSET ?`,
      [ctx.branchId, limit, offset]
    );
    const failedTurns = queryBound(
      ctx.db,
      `SELECT id, status, receipt_json, attempts_json FROM turns WHERE branch_id = ? AND status IN ('failed','partial') ORDER BY created_wall_ms DESC LIMIT 50`,
      [ctx.branchId]
    );
    const nextOffset = offset + changes.length;
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [
        ...changes.map((c) => ({
          logId: String(c.id),
          kind: "change",
          turnId: String(c.turn_id),
          groupId: String(c.group_id),
          operationId: String(c.operation_id),
          table: String(c.target_table),
          rowId: String(c.target_row_id),
          operation: String(c.operation),
          summary: String(c.summary ?? ""),
          basis: safeJson(c.basis_json)
        })),
        ...failedTurns.map((t) => ({
          logId: `turn_${String(t.id)}`,
          kind: "failed_turn",
          turnId: String(t.id),
          status: String(t.status),
          receipt: safeJson(t.receipt_json),
          attempts: safeJson(t.attempts_json)
        }))
      ],
      nextCursor: nextOffset < totalCount ? String(nextOffset) : void 0,
      metadata: {
        totalCount,
        returned: changes.length,
        droppedCount: 0,
        pageSize: limit,
        /** 导出全部匹配记录；分页不截断导出。 */
        exportComplete: true
      }
    };
  }
  function querySimulationView(ctx, query) {
    const stale = staleResult(ctx, query.revision);
    if (stale) return stale;
    const branch = queryBound(ctx.db, "SELECT * FROM branches WHERE id = ?", [ctx.branchId])[0];
    if (!branch) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: "BRANCH_UNKNOWN" } };
    const clock = Number(branch.clock_s ?? 0);
    const cursor = Number(branch.simulation_cursor_s ?? 0);
    const pending = cursor < clock;
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [
        {
          clockS: clock,
          clockMinS: Number(branch.clock_min_s ?? 0),
          clockMaxS: Number(branch.clock_max_s ?? 0),
          calendarLabel: branch.calendar_label ?? null,
          simulationCursorS: cursor,
          simulationStatus: String(branch.simulation_status ?? "current"),
          /** UI 必须显示「后台尚未结算到当前时间」。 */
          pendingNotice: pending ? `正文时间已前进，部分后台尚在结算（未结算 ${Math.round(clock - cursor)} 秒）` : null
        }
      ],
      metadata: { pending, viewMode: ctx.viewMode ?? "author", requestedCursor: query.cursor ?? null }
    };
  }

  // src/atlas-db-repository.ts
  var CANONICAL_TABLES = /* @__PURE__ */ new Set([
    "maps",
    "locations",
    "characters",
    "items",
    "factions",
    "relations",
    "routes",
    "actions",
    "journeys",
    "events",
    "information",
    "rumor_fronts",
    "knowledge",
    "channels",
    "entity_keys",
    "branches",
    "turns",
    "turn_changes",
    "mention_candidates",
    "sync_outbox"
  ]);
  function assertTwentyTables(db) {
    const tables = userTableNames(db);
    const unexpected = tables.filter((t) => !CANONICAL_TABLES.has(t));
    const missing = [...CANONICAL_TABLES].filter((t) => !tables.includes(t));
    if (unexpected.length > 0 || missing.length > 0) {
      throw new AtlasDbError(
        "DB_SCHEMA_INVALID",
        `用户表不是预期的 20 张（多 ${unexpected.length}，少 ${missing.length}）：多 ${unexpected.join(",")}；少 ${missing.join(",")}`,
        { unexpected, missing }
      );
    }
    return tables;
  }
  function createSqlRepository(options) {
    const now = options.now ?? (() => Date.now());
    const chatUid = options.chatUid;
    const worldUid = options.worldUid ?? `world_${chatUid}`;
    const rulesetVersion = options.rulesetVersion ?? "atlas-1";
    const branchId = options.branchId ?? "main";
    const branchName = options.branchName ?? "主线";
    let db = null;
    let storageRevision = 0;
    let envelopeAssets = [];
    const candidates = /* @__PURE__ */ new Map();
    const staleCandidates = /* @__PURE__ */ new Set();
    let closed = false;
    const makeId = options.makeId ?? ((kind, opId, alias) => defaultMakeId2({
      chatUid,
      branchId,
      parentTurnId: null,
      hostMessageUid: "",
      variantKey: "",
      baseRevision: 0,
      baseStorageRevision: 0,
      inputHash: ""
    })(kind, opId, alias));
    function requireDb() {
      if (!db || closed) throw new AtlasDbError("DB_NOT_OPEN", "数据库尚未打开", { chatUid });
      return db;
    }
    function branchRow() {
      const rows2 = queryBound(requireDb(), "SELECT * FROM branches WHERE id = ? LIMIT 1", [branchId]);
      if (rows2.length === 0) return null;
      const decoded = decodeRow("branches", rows2[0], { allowExtra: true });
      return decoded.ok ? decoded.row : rows2[0];
    }
    function currentRevision() {
      const row2 = branchRow();
      return row2 ? Number(row2.revision ?? 0) : 0;
    }
    function currentHeadTurnId() {
      const row2 = branchRow();
      return row2 && row2.head_turn_id ? String(row2.head_turn_id) : null;
    }
    function currentClock() {
      const row2 = branchRow();
      return row2 ? Number(row2.clock_s ?? 0) : 0;
    }
    function seedNewDatabase(seedBranchId, seedBranchName) {
      const target = requireDb();
      installSchemaSafe(target);
      const wall = now();
      const seedTurnId = `turn_migration_${chatUid}`;
      beginTransaction(target);
      try {
        runBound(
          target,
          `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash, base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
         VALUES (?, ?, NULL, NULL, NULL, 'migration', ?, NULL, 0, 0, 0, ?, 0, ?, ?, ?, NULL, ?, 'committed', ?, ?)`,
          [
            seedTurnId,
            seedBranchId,
            sha256HexSync(`atlas-seed:${chatUid}:${seedBranchId}`),
            JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: "explicit", basis_refs: [] }),
            sha256HexSync(`atlas-seed-rng:${chatUid}`),
            rulesetVersion,
            JSON.stringify({ operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] }),
            JSON.stringify([]),
            wall,
            wall
          ]
        );
        runBound(
          target,
          `INSERT INTO branches (id, parent_branch_id, fork_turn_id, head_turn_id, revision, name, pov_character_id, root_map_id, clock_s, clock_min_s, clock_max_s, calendar_label, simulation_cursor_s, simulation_status, ruleset_version, status, created_wall_ms)
         VALUES (?, NULL, NULL, ?, 0, ?, NULL, NULL, 0, 0, 0, NULL, 0, 'current', ?, 'active', ?)`,
          [seedBranchId, seedTurnId, seedBranchName, rulesetVersion, wall]
        );
        commitTransaction(target);
      } catch (err) {
        rollbackTransaction(target);
        throw err instanceof AtlasDbError ? err : new AtlasDbError("DB_SEED_FAILED", `建立初始分支/推演记录失败：${err.message}`, {});
      }
    }
    async function createCandidateImpl(anchor, kind = "turn") {
      const snapshot = requireDb().export();
      const candidateDb = await openDatabase(snapshot);
      enableForeignKeys(candidateDb);
      const token = `cand_${sha256HexSync(`${chatUid}\0${anchor.hostMessageUid}\0${anchor.variantKey}\0${now()}\0${candidates.size}`).slice(0, 24)}`;
      const info = {
        token,
        kind,
        anchor,
        db: candidateDb,
        snapshot,
        snapshotSha256: await sha256Hex4(snapshot),
        preparedWallMs: now(),
        expiresWallMs: now() + ATLAS_RUNTIME_LIMITS.pendingCandidateTtlMs,
        receipt: null,
        envelope: null
      };
      candidates.set(token, info);
      return info;
    }
    async function exportCandidateImpl(candidate, receipt) {
      const stored = candidates.get(candidate.token);
      if (!stored) throw new AtlasDbError("CANDIDATE_UNKNOWN", `候选不存在或已丢弃：${candidate.token}`, { token: candidate.token });
      const bytes = stored.db.export();
      const snapshotSha256 = await sha256Hex4(bytes);
      const envelope = await encodeSnapshot(bytes, {
        chatUid,
        worldUid,
        storageRevision: storageRevision + 1,
        activeBranchId: candidate.anchor.branchId,
        schemaVersion: ATLAS_SCHEMA_VERSION
      });
      stored.snapshot = bytes;
      stored.snapshotSha256 = snapshotSha256;
      stored.envelope = envelope;
      stored.receipt = receipt;
      stored.expiresWallMs = now() + ATLAS_RUNTIME_LIMITS.pendingCandidateTtlMs;
      return {
        kind: "turn",
        token: stored.token,
        anchor: candidate.anchor,
        snapshot: bytes,
        snapshotSha256,
        receipt,
        expiresWallMs: stored.expiresWallMs
      };
    }
    async function discardPreparedImpl(token) {
      const stored = candidates.get(token);
      if (!stored) return;
      stored.db.close();
      candidates.delete(token);
    }
    const repo2 = {
      get db() {
        return requireDb();
      },
      get branchId() {
        return branchId;
      },
      get chatUid() {
        return chatUid;
      },
      get worldUid() {
        return worldUid;
      },
      get storageRevision() {
        return storageRevision;
      },
      /** B05 open：新建有 migration/seed turn 和 branch；根图可存在而无「起点」实体。 */
      async open(openOptions = {}) {
        if (openOptions.bytes && openOptions.bytes.length > 0) {
          db = await openDatabase(openOptions.bytes);
          enableForeignKeys(db);
          assertTwentyTables(db);
          const existingBranch = queryBound(db, "SELECT id FROM branches WHERE id = ? LIMIT 1", [branchId]);
          if (existingBranch.length === 0) {
            const anyBranch = queryBound(db, "SELECT id FROM branches ORDER BY created_wall_ms LIMIT 1", []);
            if (anyBranch.length === 0) {
              seedNewDatabase(branchId, branchName);
            } else {
              throw new AtlasDbError("DB_BRANCH_MISSING", `存档里没有分支 ${branchId}；不自动建一个新空世界`, {
                requested: branchId,
                available: anyBranch.map((r) => String(r.id))
              });
            }
          }
          storageRevision = Number(openOptions.envelope?.storage_revision ?? 0);
          envelopeAssets = Array.isArray(openOptions.envelope?.assets) ? [...openOptions.envelope.assets] : [];
          return;
        }
        if (openOptions.seed === false) {
          db = await openDatabase();
          return;
        }
        db = await openDatabase();
        seedNewDatabase(openOptions.branchId ?? branchId, openOptions.branchName ?? branchName);
        storageRevision = 0;
        envelopeAssets = [];
      },
      /** 只读查询入口：所有视图共用一个 branch/revision。 */
      async queryView(query) {
        const target = requireDb();
        const ctx = {
          db: target,
          branchId: query.branchId || branchId,
          revision: currentRevision(),
          viewMode: query.viewMode,
          povId: query.povId ?? branchRow()?.pov_character_id ?? null,
          // §7.1 第 6 条：把随存档带来的资产清单交给视图层，由它产出缺底图诊断。
          assets: envelopeAssets
        };
        switch (query.kind) {
          case "map":
            return queryMapView(ctx, query);
          case "nearby":
            return queryNearby(ctx, query);
          case "entity":
            return queryEntityDetail(ctx, query);
          case "changes":
            return queryChanges(ctx, query);
          case "diagnostics":
            return queryDiagnostics(ctx, query);
          case "simulation":
            return querySimulationView(ctx, query);
          default:
            return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: "VIEW_KIND_UNSUPPORTED", kind: query.kind } };
        }
      },
      async exportCurrent() {
        return requireDb().export();
      },
      /** 当前库的存档信封（供宿主保存使用）。 */
      async currentEnvelope() {
        const bytes = requireDb().export();
        return encodeSnapshot(bytes, {
          chatUid,
          worldUid,
          storageRevision,
          activeBranchId: branchId,
          schemaVersion: ATLAS_SCHEMA_VERSION
        });
      },
      /** B06 createCandidate：从当前库快照建隔离候选；候选改动不出现在正式 query 中。 */
      async createCandidate(anchor, kind = "turn") {
        const snapshot = requireDb().export();
        const candidateDb = await openDatabase(snapshot);
        enableForeignKeys(candidateDb);
        const token = `cand_${sha256HexSync(`${chatUid}\0${anchor.hostMessageUid}\0${anchor.variantKey}\0${now()}\0${candidates.size}`).slice(0, 24)}`;
        const info = {
          token,
          kind,
          anchor,
          db: candidateDb,
          snapshot,
          snapshotSha256: await sha256Hex4(snapshot),
          preparedWallMs: now(),
          expiresWallMs: now() + ATLAS_RUNTIME_LIMITS.pendingCandidateTtlMs,
          receipt: null,
          envelope: null
        };
        candidates.set(token, info);
        return info;
      },
      getCandidate(token) {
        return candidates.get(token) ?? null;
      },
      /** B07 exportCandidate：export + SHA256 → PreparedCommit。 */
      async exportCandidate(candidate, receipt) {
        const stored = candidates.get(candidate.token);
        if (!stored) throw new AtlasDbError("CANDIDATE_UNKNOWN", `候选不存在或已丢弃：${candidate.token}`, { token: candidate.token });
        const bytes = stored.db.export();
        const snapshotSha256 = await sha256Hex4(bytes);
        const envelope = await encodeSnapshot(bytes, {
          chatUid,
          worldUid,
          storageRevision: storageRevision + 1,
          activeBranchId: candidate.anchor.branchId,
          schemaVersion: ATLAS_SCHEMA_VERSION
        });
        stored.snapshot = bytes;
        stored.snapshotSha256 = snapshotSha256;
        stored.envelope = envelope;
        stored.receipt = receipt;
        stored.expiresWallMs = now() + ATLAS_RUNTIME_LIMITS.pendingCandidateTtlMs;
        return {
          kind: "turn",
          token: stored.token,
          anchor: candidate.anchor,
          snapshot: bytes,
          snapshotSha256,
          receipt,
          expiresWallMs: stored.expiresWallMs
        };
      },
      /** B08 confirmSaved：token+hash 一致且 saved 才切正式库；requested 保留待确认。 */
      async confirmSaved(ack) {
        const stored = candidates.get(ack.token);
        if (!stored) {
          if (staleCandidates.has(ack.token)) {
            throw new AtlasDbError(
              "STALE_BASE",
              "该候选基于的 revision 已被同一聊天的另一次提交占用（候选已作废，未发布任何内容）",
              { token: ack.token, current: currentRevision() }
            );
          }
          throw new AtlasDbError("CANDIDATE_UNKNOWN", `确认保存失败：候选不存在或已丢弃（token=${ack.token}）`, { token: ack.token });
        }
        if (stored.expiresWallMs < now() && ack.result !== "saved") {
          throw new AtlasDbError("CANDIDATE_EXPIRED", `候选已过期（token=${ack.token}）`, { token: ack.token });
        }
        if (ack.result === "saved" && stored.anchor.baseRevision !== currentRevision()) {
          throw new AtlasDbError(
            "STALE_BASE",
            `发布前基线已变化：候选基于 revision ${stored.anchor.baseRevision}，当前 ${currentRevision()}（拒绝发布，不覆盖已有提交）`,
            { base: stored.anchor.baseRevision, current: currentRevision(), token: ack.token }
          );
        }
        if (stored.snapshotSha256 !== ack.snapshotSha256) {
          throw new AtlasDbError("CANDIDATE_HASH_MISMATCH", `确认保存的哈希与候选不一致：候选 ${stored.snapshotSha256}，确认 ${ack.snapshotSha256}`, {
            token: ack.token
          });
        }
        if (ack.result === "saved") {
          const old = db;
          db = stored.db;
          enableForeignKeys(db);
          storageRevision += 1;
          candidates.delete(ack.token);
          for (const [token, other] of candidates) {
            if (other.kind === "turn" && other.anchor.chatUid === chatUid) {
              staleCandidates.add(token);
              other.db.close();
              candidates.delete(token);
            }
          }
          if (old && old !== db) old.close();
          return;
        }
        if (ack.result === "requested") {
          return;
        }
        stored.db.close();
        candidates.delete(ack.token);
      },
      /** B09 discardPrepared：保存失败前后正式库哈希一致。 */
      async discardPrepared(token) {
        const stored = candidates.get(token);
        if (!stored) return;
        stored.db.close();
        candidates.delete(token);
      },
      /** B17 close：关闭正式库/候选库；重复打开关闭不累积句柄。 */
      async close() {
        for (const stored of candidates.values()) stored.db.close();
        candidates.clear();
        if (db) db.close();
        db = null;
        closed = true;
      },
      /** E06 prepareTurn：读取 → 模型 → 编译 → 修复一次 → 应用 → 导出。 */
      async prepareTurn(input) {
        return prepareTurnInner(input);
      },
      /** E09 prepareRollback：在候选库恢复数据/clock/knowledge，生成新同步意图。 */
      async prepareRollback(input) {
        return prepareRollbackInner(input);
      },
      /** B18 prepareMaintenance：只改 outbox/失败尝试，走同一导出/保存确认。 */
      async prepareMaintenance(input) {
        return prepareMaintenanceInner(input);
      },
      /** B19 rebaseCandidateIfMetadataOnly：仅内部维护变化时在最新快照重放已接受结果。 */
      async rebaseCandidateIfMetadataOnly(candidate, currentRevision_) {
        const stored = candidates.get(candidate.token);
        if (!stored) return { rebased: false, reason: "CANDIDATE_UNKNOWN" };
        if (stored.anchor.baseRevision !== currentRevision_) {
          return { rebased: false, reason: "STALE_BASE" };
        }
        const latestStorage = storageRevision;
        if (latestStorage <= stored.anchor.baseStorageRevision) {
          return { rebased: false, reason: "NO_METADATA_CHANGE" };
        }
        stored.anchor = { ...stored.anchor, baseStorageRevision: latestStorage };
        return { rebased: true, reason: "METADATA_ONLY" };
      },
      /** 内部：给编译/提交用的一次性上下文（测试与维护脚本也用它）。 */
      internal: {
        makeId,
        branchId,
        chatUid,
        currentRevision,
        currentClock,
        currentHeadTurnId,
        branchRow
      }
    };
    return repo2;
    async function prepareTurnInner(input) {
      requireDb();
      const anchor = input.anchor;
      if (anchor.chatUid !== chatUid) {
        throw new AtlasDbError("CHAT_CHANGED", `提交锚点属于另一个聊天：${anchor.chatUid}`, { expected: chatUid, actual: anchor.chatUid });
      }
      const rev = currentRevision();
      if (anchor.baseRevision !== rev) {
        throw new AtlasDbError("STALE_BASE", `基版本已变化：锚点 ${anchor.baseRevision}，当前 ${rev}`, { base: anchor.baseRevision, current: rev });
      }
      const candidate = await createCandidateImpl(anchor, "turn");
      const candidateDb = candidates.get(candidate.token).db;
      const tables = createTableReadPort(candidateDb);
      const clockBefore = currentClock();
      const turnId = `turn_${sha256HexSync(`${chatUid}\0${anchor.branchId}\0${anchor.hostMessageUid}\0${anchor.variantKey}\0${anchor.inputHash}`).slice(0, 24)}`;
      const allIssues = [];
      const parsedOperations = [];
      const attempts = [];
      let explicitNoop = false;
      let responseIncomplete = false;
      let repairAttempted = false;
      let worldChanged = false;
      let timeChanged = false;
      let modelPhaseFailed = false;
      const sourceSnapshot = input.sourceSnapshot ?? [];
      if (input.manual) {
        const manualOps = input.operations ?? [];
        manualOps.forEach((value, index) => {
          const raw = JSON.stringify(value);
          parsedOperations.push({
            opId: `op_manual_${index}_${sha256HexSync(raw).slice(0, 8)}`,
            line: index + 1,
            rawHash: sha256HexSync(raw),
            value
          });
        });
      } else {
        const phases = input.phaseBatches?.length ? input.phaseBatches : ["observe"];
        let phaseIndex = 0;
        for (const phase of phases) {
          if (phaseIndex >= ATLAS_RUNTIME_LIMITS.foregroundModelBatchesPerTurn) {
            allIssues.push({
              code: "BUDGET_EXHAUSTED",
              path: "$.phaseBatches",
              message: `前台模型批次数已达上限 ${ATLAS_RUNTIME_LIMITS.foregroundModelBatchesPerTurn}；剩余阶段保存在行动队列并标记 catching_up`,
              severity: "warning",
              retryable: true
            });
            break;
          }
          phaseIndex += 1;
          if (!options.modelPort) {
            modelPhaseFailed = true;
            allIssues.push({
              code: "MODEL_PORT_MISSING",
              path: "$.modelPort",
              message: "没有可用的模型端口：本轮不产生模型变更（不伪造 noop 成功）",
              severity: "error",
              retryable: true
            });
            break;
          }
          const request = buildStagePrompt({
            phase,
            allowedOps: input.manual ? void 0 : void 0,
            assistantSource: input.assistantText,
            userSource: input.userText,
            entityRefs: collectEntityRefs(tables, branchId),
            batchId: `${phase}_${turnId}`
          });
          request.anchor = anchor;
          const startedWall = now();
          let response;
          try {
            response = await options.modelPort.request(request);
          } catch (err) {
            modelPhaseFailed = true;
            allIssues.push({
              code: "MODEL_TIMEOUT",
              path: "$.modelPort",
              message: `模型请求失败：${err.message}`,
              severity: "error",
              retryable: true
            });
            attempts.push({ id: `att_${attempts.length}`, kind: "initial", phase, error: err.message });
            break;
          }
          attempts.push({
            id: `att_${attempts.length}`,
            kind: "initial",
            phase,
            started_wall_ms: startedWall,
            finished_wall_ms: now(),
            http_status: response.httpStatus,
            response_chars: response.text?.length ?? 0,
            response_hash: sha256HexSync(response.text ?? ""),
            finish_reason: response.finishReason
          });
          const extracted = extractPayload(response.text ?? "");
          if (extracted.incomplete) responseIncomplete = true;
          allIssues.push(...extracted.issues);
          if (looksLikeSql(extracted.payload)) {
            allIssues.push({
              code: "UNSUPPORTED_RESPONSE_FORMAT",
              path: "$.response",
              message: "响应是 SQL 而不是语义操作：不直接 db.run，也不伪装 noop 成功",
              severity: "error",
              retryable: true
            });
            modelPhaseFailed = true;
            continue;
          }
          const parsed = parseOperations(extracted.payload, { phase });
          if (parsed.incomplete) responseIncomplete = true;
          allIssues.push(...parsed.issues);
          if (parsed.explicitNoop) explicitNoop = true;
          if (parsed.operations.length === 0 && !parsed.explicitNoop && !extracted.reasoningBlocked) {
            allIssues.push({
              code: "EMPTY_RESPONSE",
              path: "$.response",
              message: "模型返回空内容（不是 noop）：保留可独立完成的程序变更，明确模型阶段失败",
              severity: "error",
              retryable: true
            });
            modelPhaseFailed = true;
            continue;
          }
          parsedOperations.push(...parsed.operations);
        }
      }
      const revAfterModel = currentRevision();
      if (revAfterModel !== anchor.baseRevision) {
        await discardPreparedImpl(candidate.token);
        throw new AtlasDbError(
          "STALE_BASE",
          `模型响应期间基线已变化：候选基于 revision ${anchor.baseRevision}，当前 ${revAfterModel}（候选已丢弃）`,
          { base: anchor.baseRevision, current: revAfterModel }
        );
      }
      const compilePhase = "observe";
      const compiled = compileOperations({
        operations: parsedOperations,
        anchor,
        phase: compilePhase,
        clockS: clockBefore,
        revision: rev,
        tables,
        sources: { phase: compilePhase, snapshot: sourceSnapshot, clockS: clockBefore },
        makeId,
        knownRefs: collectKnownRefs(tables, branchId),
        // 审计列（created_turn_id/updated_turn_id/first_turn_id/last_turn_id）记本次新建的楼。
        turnId,
        // manual = 统一写入层：按操作本身判定允许集合，不受 observe 限制。
        ...input.manual ? { allowedOps: ATLAS_SEMANTIC_OPS } : {}
      });
      allIssues.push(...compiled.issues);
      const compileInputs = compiled.results.map((r) => ({
        opId: r.opId,
        issues: r.result.issues,
        mutations: r.result.mutations,
        readSet: r.result.readSet,
        dependencies: r.result.dependencies,
        entityKeyWrites: r.result.entityKeyWrites,
        operationKeys: r.result.operationKeys
      }));
      const built = buildAtomicGroups(compileInputs);
      allIssues.push(...built.issues);
      const ordered = orderGroups(built.groups);
      allIssues.push(...ordered.issues);
      let groupResults = [];
      let sequencesUsed = 0;
      beginTransaction(candidateDb);
      let committed = false;
      try {
        insertTurnRow(candidateDb, {
          turnId,
          anchor,
          kind: input.manual ? "manual" : "narrative",
          clockBefore,
          clockAfter: clockBefore,
          storyHash: input.assistantText ? sha256HexSync(input.assistantText) : null,
          attempts
        });
        const applied = applyGroups(candidateDb, ordered.order, {
          branchId,
          turnId,
          attemptId: input.manual ? "manual" : "model",
          validate: true
        });
        groupResults = applied.groups;
        sequencesUsed = applied.sequencesUsed;
        for (const gi of applied.journalIssues) {
          allIssues.push({ code: "JOURNAL_WRITE_FAILED", path: "$.turn_changes", message: gi, severity: "error", retryable: false });
        }
        const rejected = groupResults.filter((g) => g.status === "rejected");
        const rejectedSnapshot = [...rejected];
        if (rejected.length > 0 && !input.manual && options.modelPort) {
          const repairOutcome = await runRepair({
            candidateDb,
            rejected,
            compiled,
            anchor,
            clockBefore,
            rev,
            sourceSnapshot,
            attempts,
            allIssues,
            modelPort: options.modelPort,
            makeId
          });
          repairAttempted = true;
          if (repairOutcome.applied.length > 0) {
            const second = applyGroups(candidateDb, repairOutcome.applied, {
              branchId,
              turnId: `${turnId}_repair`,
              attemptId: "repair",
              validate: true
            });
            groupResults = reconcileRepairResults(groupResults, second.groups, rejectedSnapshot);
          }
        }
        const fkViolations = foreignKeyCheck(candidateDb);
        const finalCheck = validateCandidate(candidateDb, { branchId });
        const ok = fkViolations.length === 0 && finalCheck.ok;
        if (!ok) {
          throw new AtlasDbError(
            "INVARIANT_FAILED",
            `候选核心一致性校验失败：${finalCheck.violations.slice(0, 5).map((v) => `${v.code}@${v.table}`).join("; ") || "foreign_key_check"}`,
            { violations: finalCheck.violations, foreignKeys: fkViolations }
          );
        }
        const appliedGroups = groupResults.filter((g) => g.status === "applied");
        worldChanged = appliedGroups.some((g) => g.changedRows > 0);
        const newRevision = rev + (worldChanged ? 1 : 0);
        const receipt = buildReceipt({
          turnId,
          anchor,
          groupResults,
          issues: allIssues,
          clockBefore,
          clockAfter: clockBefore,
          simulatedUntil: clockBefore,
          worldChanged,
          timeChanged,
          explicitNoop,
          modelPhaseFailed,
          incomplete: responseIncomplete,
          repairAttempted
        });
        runBound(candidateDb, `UPDATE turns SET status = ?, committed_revision = ?, receipt_json = ?, attempts_json = ?, decisions_json = ? WHERE id = ?`, [
          receipt.status === "failed" ? "failed" : receipt.status === "partial" ? "partial" : "committed",
          receipt.status === "failed" ? null : newRevision,
          JSON.stringify(receipt),
          JSON.stringify(attempts.slice(0, ATLAS_RUNTIME_LIMITS.detailedAttemptsPerTurn)),
          JSON.stringify({ operations: parsedOperations.map((p) => p.value), attention_decisions: [], outcome_decisions: [], random_draws: [] }),
          turnId
        ]);
        runBound(
          candidateDb,
          `UPDATE branches SET head_turn_id = ?, revision = ?, clock_s = ?, clock_min_s = ?, clock_max_s = ?, simulation_cursor_s = ?, simulation_status = ? WHERE id = ?`,
          [
            receipt.status === "failed" ? currentHeadTurnId() : turnId,
            newRevision,
            clockBefore,
            clockBefore,
            clockBefore,
            clockBefore,
            "current",
            branchId
          ]
        );
        if (worldChanged) {
          enqueueProjectionSync(candidateDb, {
            branchId,
            turnId,
            targetRevision: newRevision,
            projectionScope: "pov",
            payloadHash: projectionHash({ turnId, revision: newRevision, operations: parsedOperations.length }),
            nowWallMs: now(),
            makeId: (key) => makeId("outbox", turnId, key)
          });
        }
        commitTransaction(candidateDb);
        committed = true;
        if (receipt.status === "failed") {
          await discardPreparedImpl(candidate.token);
          throw new AtlasDbError("TURN_FAILED", "本轮没有任何有效变更（模型阶段失败且无程序结算）：候选已丢弃", {
            receipt
          });
        }
        return await exportCandidateImpl(candidate, receipt);
      } catch (err) {
        if (!committed) {
          rollbackTransaction(candidateDb);
          await discardPreparedImpl(candidate.token);
        } else if (err instanceof AtlasDbError && err.code === "TURN_FAILED") {
          throw err;
        } else {
          await discardPreparedImpl(candidate.token);
        }
        if (err instanceof AtlasDbError) throw err;
        throw new AtlasDbError("TURN_PREPARE_FAILED", `准备回合失败：${err.message}`, { sequencesUsed });
      }
    }
    async function runRepair(args) {
      const failedOps = args.rejected.flatMap(
        (g) => g.opIds.map((opId) => {
          const original = args.compiled.normalized.find((o) => o.opId === opId);
          return {
            op: original ?? { opId, line: 0, rawHash: "", value: { op: "noop" } },
            issues: g.issues,
            readSet: args.compiled.results.find((r) => r.opId === opId)?.result.readSet ?? []
          };
        })
      );
      if (failedOps.length === 0) return { applied: [] };
      const allowedOps = new Set(failedOps.map((f) => f.op.value.op));
      const repair = buildRepairBatch(failedOps, { phase: "repair", allowedOps: [...allowedOps] });
      args.allIssues.push(...repair.issues);
      const request = buildStagePrompt({
        phase: "repair",
        allowedOps: [...allowedOps],
        repairTickets: repair.promptLines.join("\n"),
        batchId: `${repair.batchId}`,
        repairOfBatchId: repair.batchId
      });
      request.anchor = args.anchor;
      let response;
      try {
        response = await args.modelPort.request(request);
      } catch (err) {
        args.allIssues.push({
          code: "REPAIR_REQUEST_FAILED",
          path: "$.repair",
          message: `纠错请求失败：${err.message}`,
          severity: "error",
          retryable: true
        });
        return { applied: [] };
      }
      args.attempts.push({
        id: `att_${args.attempts.length}`,
        kind: "repair",
        requested_operation_ids: failedOps.map((f) => f.op.opId),
        http_status: response.httpStatus,
        response_chars: response.text?.length ?? 0,
        response_hash: sha256HexSync(response.text ?? "")
      });
      const extracted = extractPayload(response.text ?? "");
      args.allIssues.push(...extracted.issues);
      const parsed = parseOperations(extracted.payload, { phase: "repair", allowedOps: [...allowedOps] });
      args.allIssues.push(...parsed.issues);
      const merged = mergeRepair(
        failedOps.map((f) => f.op),
        parsed.operations,
        repair.tickets,
        { phase: "repair", attemptsUsed: 0 }
      );
      args.allIssues.push(...merged.issues);
      if (merged.operations.length === 0) return { applied: [] };
      const tables = createTableReadPort(args.candidateDb);
      const recompiled = compileOperations({
        operations: merged.operations,
        anchor: args.anchor,
        phase: "repair",
        clockS: args.clockBefore,
        revision: args.rev,
        tables,
        sources: { phase: "repair", snapshot: args.sourceSnapshot, clockS: args.clockBefore },
        makeId: args.makeId,
        knownRefs: collectKnownRefs(tables, branchId)
      });
      args.allIssues.push(...recompiled.issues);
      const built = buildAtomicGroups(
        recompiled.results.map((r) => ({
          opId: r.opId,
          issues: r.result.issues,
          mutations: r.result.mutations,
          readSet: r.result.readSet,
          dependencies: r.result.dependencies,
          entityKeyWrites: r.result.entityKeyWrites,
          operationKeys: r.result.operationKeys
        }))
      );
      args.allIssues.push(...built.issues);
      const ordered = orderGroups(built.groups);
      args.allIssues.push(...ordered.issues);
      return { applied: ordered.order };
    }
    async function prepareRollbackInner(input) {
      if (input.chatUid !== chatUid) {
        throw new AtlasDbError("CHAT_CHANGED", `回退请求属于另一个聊天：${input.chatUid}`, { expected: chatUid, actual: input.chatUid });
      }
      const rev = currentRevision();
      if (input.expectedRevision !== void 0 && input.expectedRevision !== rev) {
        throw new AtlasDbError("STALE_BASE", `回退基版本不一致：请求 ${input.expectedRevision}，当前 ${rev}`, { expected: input.expectedRevision, current: rev });
      }
      const target = requireDb();
      const targetTurn = queryBound(target, "SELECT id, branch_id, clock_before_s, parent_turn_id FROM turns WHERE id = ? LIMIT 1", [
        input.targetParentTurnId
      ]);
      if (targetTurn.length === 0) {
        throw new AtlasDbError("REF_UNKNOWN", `找不到要回退到的 turn：${input.targetParentTurnId}`, { target: input.targetParentTurnId });
      }
      const anchor = {
        chatUid,
        branchId,
        parentTurnId: input.targetParentTurnId,
        hostMessageUid: input.targetParentTurnId,
        variantKey: "rollback",
        baseRevision: rev,
        baseStorageRevision: storageRevision,
        inputHash: sha256HexSync(`rollback:${input.targetParentTurnId}`)
      };
      const candidate = await createCandidateImpl(anchor, "rollback");
      const candidateDb = candidates.get(candidate.token).db;
      beginTransaction(candidateDb);
      let committed = false;
      const result_issues_of_rollback = [];
      try {
        const plan = planRollback({
          db: candidateDb,
          branchId,
          targetTurnId: input.targetParentTurnId,
          expectedRevision: input.expectedRevision
        });
        const rollbackTurnId = `turn_rollback_${sha256HexSync(`${chatUid}:${input.targetParentTurnId}:${rev}`).slice(0, 20)}`;
        insertTurnRow(candidateDb, {
          turnId: rollbackTurnId,
          anchor,
          kind: "fork",
          clockBefore: currentClock(),
          clockAfter: plan.clockTargetS,
          storyHash: null,
          attempts: []
        });
        const rowPlan = { ...plan, steps: plan.steps.filter((step) => step.targetTable !== "branches") };
        const appliedPlan = await applyRollbackPlan(candidateDb, rowPlan, { turnId: rollbackTurnId, attemptId: "rollback" });
        for (const note2 of appliedPlan.issues) {
          result_issues_of_rollback.push(note2);
        }
        for (const turnId of plan.turns) {
          runBound(candidateDb, `UPDATE turns SET status = 'rolled_back' WHERE id = ?`, [turnId]);
        }
        const clockAfter = plan.clockTargetS;
        runBound(
          candidateDb,
          `UPDATE branches SET head_turn_id = ?, revision = ?, clock_s = ?, clock_min_s = ?, clock_max_s = ?, simulation_cursor_s = ?, simulation_status = 'current' WHERE id = ?`,
          [input.targetParentTurnId, rev + 1, clockAfter, clockAfter, clockAfter, clockAfter, branchId]
        );
        const finalCheck = validateCandidate(candidateDb, { branchId });
        if (!finalCheck.ok) {
          throw new AtlasDbError("INVARIANT_FAILED", `回退后候选校验失败：${finalCheck.violations.slice(0, 5).map((v) => `${v.code}@${v.table}`).join("; ")}`, {
            violations: finalCheck.violations
          });
        }
        const receipt = {
          turnId: rollbackTurnId,
          anchor,
          status: "committed",
          groups: [],
          issues: result_issues_of_rollback,
          clockBeforeS: Number(targetTurn[0].clock_before_s ?? 0),
          clockAfterS: clockAfter,
          simulatedUntilS: clockAfter,
          worldChanged: true,
          timeChanged: true
        };
        runBound(candidateDb, `UPDATE turns SET status = 'committed', committed_revision = ?, receipt_json = ? WHERE id = ?`, [
          rev + 1,
          JSON.stringify(receipt),
          rollbackTurnId
        ]);
        enqueueProjectionSync(candidateDb, {
          branchId,
          turnId: rollbackTurnId,
          targetRevision: rev + 1,
          projectionScope: "pov",
          payloadHash: projectionHash({ rollback: input.targetParentTurnId, revision: rev + 1 }),
          nowWallMs: now(),
          makeId: (key) => makeId("outbox", rollbackTurnId, key)
        });
        commitTransaction(candidateDb);
        committed = true;
        const prepared = await exportCandidateImpl(candidate, receipt);
        return { ...prepared, kind: "rollback" };
      } catch (err) {
        if (!committed) rollbackTransaction(candidateDb);
        await discardPreparedImpl(candidate.token);
        if (err instanceof AtlasDbError) throw err;
        throw new AtlasDbError("ROLLBACK_FAILED", `回退失败：${err.message}`, {});
      }
    }
    async function prepareMaintenanceInner(input) {
      const anchor = input.anchor;
      if (anchor.chatUid !== chatUid) {
        throw new AtlasDbError("CHAT_CHANGED", `维护请求属于另一个聊天：${anchor.chatUid}`, { expected: chatUid, actual: anchor.chatUid });
      }
      const candidate = await createCandidateImpl(anchor, "maintenance");
      const candidateDb = candidates.get(candidate.token).db;
      beginTransaction(candidateDb);
      let committed = false;
      try {
        for (const update of input.outboxResults ?? []) {
          const rows2 = queryBound(candidateDb, "SELECT status, attempt_count FROM sync_outbox WHERE id = ? LIMIT 1", [update.taskId]);
          if (rows2.length === 0) {
            throw new AtlasDbError("REF_UNKNOWN", `维护更新指向不存在的同步任务：${update.taskId}`, { taskId: update.taskId });
          }
          if (String(rows2[0].status) !== update.expectedStatus) {
            throw new AtlasDbError("SESSION_STALE", `同步任务状态已变化：期望 ${update.expectedStatus}，实际 ${String(rows2[0].status)}`, {
              taskId: update.taskId
            });
          }
          runBound(
            candidateDb,
            `UPDATE sync_outbox SET status = ?, attempt_count = ?, next_retry_wall_ms = ?, last_error_code = ?, last_error_message = ?, completed_wall_ms = ? WHERE id = ?`,
            [
              update.nextStatus,
              update.attemptCount,
              update.nextRetryWallMs ?? null,
              update.lastErrorCode ?? null,
              update.lastErrorMessage ?? null,
              update.completedWallMs ?? null,
              update.taskId
            ]
          );
        }
        if (input.failedAttempt) {
          const diagnosticTurnId = input.failedAttempt.turnId ?? `turn_failed_${sha256HexSync(`${chatUid}:${anchor.hostMessageUid}:${anchor.variantKey}`).slice(0, 20)}`;
          const existing = queryBound(candidateDb, "SELECT id FROM turns WHERE id = ? LIMIT 1", [diagnosticTurnId]);
          if (existing.length === 0) {
            insertTurnRow(candidateDb, {
              turnId: diagnosticTurnId,
              anchor,
              kind: "background",
              clockBefore: currentClock(),
              clockAfter: currentClock(),
              storyHash: null,
              attempts: [input.failedAttempt.attempt]
            });
            runBound(candidateDb, `UPDATE turns SET status = 'failed', committed_revision = NULL, receipt_json = ? WHERE id = ?`, [
              JSON.stringify({ groups: [], issues: input.failedAttempt.issues }),
              diagnosticTurnId
            ]);
          } else {
            runBound(candidateDb, `UPDATE turns SET status = 'failed', receipt_json = ? WHERE id = ?`, [
              JSON.stringify({ groups: [], issues: input.failedAttempt.issues }),
              diagnosticTurnId
            ]);
          }
        }
        commitTransaction(candidateDb);
        committed = true;
        const bytes = candidateDb.export();
        const snapshotSha256 = await sha256Hex4(bytes);
        const envelope = await encodeSnapshot(bytes, {
          chatUid,
          worldUid,
          storageRevision: storageRevision + 1,
          activeBranchId: branchId,
          schemaVersion: ATLAS_SCHEMA_VERSION
        });
        const stored = candidates.get(candidate.token);
        stored.snapshot = bytes;
        stored.snapshotSha256 = snapshotSha256;
        stored.envelope = envelope;
        return {
          kind: "maintenance",
          token: candidate.token,
          anchor,
          snapshot: bytes,
          snapshotSha256,
          expiresWallMs: stored.expiresWallMs,
          receipt: null
        };
      } catch (err) {
        if (!committed) rollbackTransaction(candidateDb);
        await discardPreparedImpl(candidate.token);
        if (err instanceof AtlasDbError) throw err;
        throw new AtlasDbError("MAINTENANCE_FAILED", `维护更新失败：${err.message}`, {});
      }
    }
    function insertTurnRow(targetDb, args) {
      const wall = now();
      runBound(
        targetDb,
        `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash, base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending', ?, NULL)`,
        [
          args.turnId,
          branchId,
          args.anchor.parentTurnId,
          args.anchor.hostMessageUid,
          args.anchor.variantKey,
          args.kind,
          args.anchor.inputHash,
          args.storyHash,
          args.anchor.baseRevision,
          args.clockBefore,
          JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: "unknown", basis_refs: [] }),
          args.clockAfter,
          sha256HexSync(`rng:${chatUid}:${args.anchor.branchId}:${args.anchor.hostMessageUid}:${args.anchor.variantKey}:${args.anchor.inputHash}`),
          rulesetVersion,
          JSON.stringify({ operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] }),
          JSON.stringify(args.attempts),
          wall
        ]
      );
    }
  }
  function collectEntityRefs(tables, branchId) {
    const refs = [];
    const locations = tables.selectWhere("locations", { branch_id: branchId }, 200);
    const characters = tables.selectWhere("characters", { branch_id: branchId }, 200);
    const items = tables.selectWhere("items", { branch_id: branchId }, 100);
    const factions = tables.selectWhere("factions", { branch_id: branchId }, 100);
    const maps = tables.selectWhere("maps", { branch_id: branchId }, 50);
    locations.forEach((l, i) => refs.push(`L${i + 1}=${String(l.name)}（地点）`));
    characters.forEach((c, i) => refs.push(`C${i + 1}=${String(c.name)}（人物）`));
    items.forEach((it, i) => refs.push(`I${i + 1}=${String(it.name)}（物品）`));
    factions.forEach((f, i) => refs.push(`F${i + 1}=${String(f.name)}（势力）`));
    maps.forEach((m, i) => refs.push(`M${i + 1}=${String(m.name)}（地图）`));
    return refs;
  }
  function collectKnownRefs(tables, branchId) {
    const out = [];
    const push = (rows2, prefix, kind) => {
      rows2.forEach((row2, i) => {
        out.push({ alias: `${prefix}${i + 1}`, id: String(row2.id), kind, rowRev: typeof row2.row_rev === "number" ? row2.row_rev : null });
      });
    };
    push(tables.selectWhere("locations", { branch_id: branchId }, 200), "L", "location");
    push(tables.selectWhere("characters", { branch_id: branchId }, 200), "C", "character");
    push(tables.selectWhere("items", { branch_id: branchId }, 100), "I", "item");
    push(tables.selectWhere("factions", { branch_id: branchId }, 100), "F", "faction");
    push(tables.selectWhere("maps", { branch_id: branchId }, 50), "M", "map");
    return out;
  }
  function reconcileRepairResults(first, second, rejected) {
    const merged = [...first];
    const rejectedIds = new Set(rejected.map((g) => g.groupId));
    for (const g of second) {
      const idx = merged.findIndex((x) => x.groupId === g.groupId);
      if (idx >= 0) merged[idx] = g;
      else merged.push(g);
    }
    for (const r of rejected) {
      if (!merged.some((g) => g.groupId === r.groupId)) merged.push(r);
    }
    void rejectedIds;
    return merged;
  }
  function buildReceipt(args) {
    const applied = args.groupResults.filter((g) => g.status === "applied");
    const failed = args.groupResults.filter((g) => g.status === "rejected" || g.status === "blocked");
    let status;
    if (applied.length === 0 && failed.length === 0) {
      status = args.modelPhaseFailed ? "failed" : args.explicitNoop || !args.worldChanged ? "noop" : "committed";
    } else if (failed.length > 0 && applied.length > 0) {
      status = "partial";
    } else if (failed.length > 0 && applied.length === 0) {
      status = "failed";
    } else {
      status = "committed";
    }
    if (args.explicitNoop && applied.length === 0 && failed.length === 0) status = "noop";
    if (args.incomplete && applied.length > 0) status = "partial";
    if (failed.length > 0 && applied.length > 0) status = "partial";
    if (args.repairAttempted && applied.length > 0) status = "partial";
    return {
      turnId: args.turnId,
      anchor: args.anchor,
      status,
      groups: args.groupResults,
      issues: args.issues,
      clockBeforeS: args.clockBefore,
      clockAfterS: args.clockAfter,
      simulatedUntilS: args.simulatedUntil,
      worldChanged: args.worldChanged,
      timeChanged: args.timeChanged
    };
  }
  function collectDescendants(db, branchId, turnId) {
    const rows2 = queryBound(db, "SELECT id, parent_turn_id, created_wall_ms FROM turns WHERE branch_id = ? ORDER BY created_wall_ms", [branchId]);
    const children = /* @__PURE__ */ new Map();
    for (const row2 of rows2) {
      const parent = row2.parent_turn_id === null || row2.parent_turn_id === void 0 ? null : String(row2.parent_turn_id);
      if (!parent) continue;
      const list = children.get(parent) ?? [];
      list.push(String(row2.id));
      children.set(parent, list);
    }
    const out = [];
    const stack = [turnId];
    const seen = /* @__PURE__ */ new Set();
    while (stack.length > 0) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      out.push(current);
      for (const child of children.get(current) ?? []) stack.push(child);
    }
    return out;
  }

  // src/atlas-db-worker.ts
  var WORKER_METHODS = [
    "open",
    "query",
    "prepareTurn",
    "prepareRollback",
    "prepareMaintenance",
    "confirmSaved",
    "discardPrepared",
    "export",
    "close"
  ];
  function toIssue3(err) {
    const anyErr = err;
    return {
      code: typeof anyErr?.code === "string" ? anyErr.code : "INTERNAL_ERROR",
      path: "$",
      message: String(anyErr?.message ?? err),
      severity: "error",
      retryable: false
    };
  }
  async function handleWorkerMessage(message, repo2, modelPort) {
    if (!message || typeof message !== "object") return null;
    if (message.type !== "request") return null;
    const { requestId, method, payload } = message;
    try {
      if (!WORKER_METHODS.includes(method)) {
        return {
          type: "response",
          requestId,
          error: { code: "WORKER_METHOD_NOT_ALLOWED", path: "$.method", message: `Worker 不接受的方法：${String(method)}`, severity: "error", retryable: false }
        };
      }
      switch (method) {
        case "open":
          await repo2.open(payload);
          return { type: "response", requestId, result: { opened: true } };
        case "query":
          return { type: "response", requestId, result: await repo2.queryView(payload) };
        case "prepareTurn": {
          const input = payload;
          void input;
          return { type: "response", requestId, result: await repo2.prepareTurn(payload) };
        }
        case "prepareRollback":
          return { type: "response", requestId, result: await repo2.prepareRollback(payload) };
        case "prepareMaintenance":
          return { type: "response", requestId, result: await repo2.prepareMaintenance(payload) };
        case "confirmSaved":
          await repo2.confirmSaved(payload);
          return { type: "response", requestId, result: { confirmed: true } };
        case "discardPrepared":
          await repo2.discardPrepared(String(payload?.token ?? ""));
          return { type: "response", requestId, result: { discarded: true } };
        case "export": {
          const bytes = await repo2.exportCurrent();
          return { type: "response", requestId, result: { base64: bytesToBase64Portable(bytes), byteLength: bytes.length } };
        }
        case "close":
          await repo2.close();
          return { type: "response", requestId, result: { closed: true } };
        default:
          return { type: "response", requestId, error: toIssue3(new Error(`未处理的方法：${method}`)) };
      }
    } catch (err) {
      return { type: "response", requestId, error: toIssue3(err) };
    } finally {
      void modelPort;
    }
  }
  function bytesToBase64Portable(bytes) {
    const BufferCtor = globalThis.Buffer;
    if (BufferCtor) return BufferCtor.from(bytes).toString("base64");
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }

  // src/atlas-sql-worker-entry.ts
  var repo = null;
  var pendingModel = /* @__PURE__ */ new Map();
  var modelSeq = 0;
  function createWorkerModelPort(scope) {
    return {
      request(input) {
        return new Promise((resolve) => {
          const requestId = `model_${++modelSeq}`;
          pendingModel.set(requestId, resolve);
          scope.postMessage({ type: "model.request", requestId, input });
        });
      }
    };
  }
  function createSqlWorkerHandler(scope) {
    return async function onMessage(message) {
      const msg = message;
      if (msg?.type === "model.response" && msg.requestId && pendingModel.has(msg.requestId)) {
        const resolve = pendingModel.get(msg.requestId);
        pendingModel.delete(msg.requestId);
        resolve(msg.result);
        return;
      }
      if (msg?.type === "init") {
        const payload = message;
        if (repo) {
          await repo.close();
          repo = null;
        }
        resetSqlModuleForTests();
        repo = createSqlRepository({ ...payload.options ?? {}, modelPort: createWorkerModelPort(scope) });
        scope.postMessage({ type: "response", requestId: "init", result: { ready: true } });
        return;
      }
      if (!repo) {
        scope.postMessage({
          type: "response",
          requestId: msg?.requestId ?? "",
          error: { code: "DB_NOT_OPEN", path: "$", message: "Worker 尚未 init（没有 Repository 实例）", severity: "error", retryable: false }
        });
        return;
      }
      const response = await handleWorkerMessage(
        message,
        {
          open: (payload) => repo.open(payload),
          queryView: (query) => repo.queryView(query),
          prepareTurn: (input) => repo.prepareTurn(input),
          prepareRollback: (input) => repo.prepareRollback(input),
          prepareMaintenance: (input) => repo.prepareMaintenance(input),
          confirmSaved: (ack) => repo.confirmSaved(ack),
          discardPrepared: (token) => repo.discardPrepared(token),
          exportCurrent: () => repo.exportCurrent(),
          close: () => repo.close()
        },
        null
      );
      if (response) scope.postMessage(response);
    };
  }
  function installSqlWorker(scope) {
    const handler = createSqlWorkerHandler(scope);
    if (scope.addEventListener) scope.addEventListener("message", (event) => void handler(event.data));
    else scope.onmessage = (event) => void handler(event.data);
  }
  var globalScope = globalThis;
  if (typeof globalScope.postMessage === "function" && typeof globalScope.document === "undefined") {
    installSqlWorker(globalScope);
  }
})();
