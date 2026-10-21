/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments */
/* The firmware's own conversions of stored legacy objects, as vectors and tables for the web editor's migration
 * library (app/src/legacy.js; kmplngj/Felucca#456 / #457). Built against a Felucca checkout (the firmware's sources and
 * host-test harness, tests/hostsim.c), it never runs on a device:
 *
 *   cc -O1 -w -I$FELUCCA_ROOT/build/gen -I$FELUCCA_ROOT/firmware/src -I$FELUCCA_ROOT/tests -o gen_legacy gen_legacy.c -lm
 *   ./gen_legacy tables REV > app/src/legacy_tables.js  (the parameter tables the conversions read; REV: the checkout's)
 *   ./gen_legacy vectors > legacy_vectors.json          (input bytes -> the firmware's output bytes)
 *   ./gen_legacy corpus SEED COUNT                      (more seeded vectors, compared in place, not committed)
 *
 * `test_legacy.mjs` runs both again when FELUCCA_ROOT is set and compares them with the committed files.
 *
 * The flash, storage and editor glue below is adapted from the firmware's tests/backup_test.c (same licence and
 * authors). Each project vector is the firmware's real path: the legacy bytes are committed to project slot 1 of the
 * simulated NOR flash (storage.c st_save) and read back by project.c proj_fetch (proj_import -> proj_bound ->
 * proj_pack, what a device holds in its RAM slot after boot and exports in a full backup). Each user preset bank vector
 * is upreset.c up_bank_check (what boot keeps in the RAM mirror and the bank's next write stores), then, for every
 * legacy record, the firmware's UP_GET reply of it sent back as UP_PUT (editor.c ED_UP_GET / ED_UP_PUT: up_values,
 * up_parse, up_values again): the current record version 4 / 5 with np = P_COUNT.
 *
 * Fixture records follow the firmware's host tests (tests/project_test.c fill_v2_track / fill_v3_track and the FUN2 /
 * FUN3 / FUN4 drum cases, tests/old_pack.h for FUN7..FUN9, tests/fun10_test.c for FUN10 of 103 / 104 parameters,
 * tests/upreset_test.c for record versions); the rest is a seeded pseudo-random corpus over every stored format. */
static unsigned char nor[0x100000];
#define SMP_USER_XIP(k) (nor + 0xA0000u + (k) * 0x14000u)
#define main hostsim_main
#include "hostsim.c"
#undef main

static int32_t fm1_enc_take(uint32_t e) { (void)e; return 0; }
static void fm1_irq_off(void) {}
static void fm1_irq_on(void) {}
static void lcd_sync(void) {}
static void lcd_power(uint32_t s) { (void)s; }
static void lcd_wake_now(void) {}
static void lcd_blit(uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint16_t *p)
{ (void)x; (void)y; (void)w; (void)h; (void)p; }
#define FELUCCA_FLASH 1
#include "../firmware/src/gfx.c"
#include "../firmware/src/panel.c"
#include "../firmware/src/ui.c"
static void panel_setup(void) {}

static uint8_t flash_ok = 1;
static int st_read(uint32_t off, void *dst, uint32_t n) { memcpy(dst, nor + off, n); return 0; }
static int st_erase(uint32_t off) { memset(nor + off, 0xFF, 4096); return 0; }
static int st_prog(uint32_t off, const void *src, uint32_t n)
{
    const uint8_t *s = src;
    uint32_t i;
    for (i = 0; i < n; i++)
        nor[off + i] &= s[i];
    return 0;
}
static uint32_t irq_save(void) { return 0; }
static void irq_restore(uint32_t f) { (void)f; }
static uint32_t fl_jedec_ram(void) { return 0; }
static void fl_plain_window_init(void) {}
#define FL_FAR(fn) (fn)
#include "../firmware/src/storage.c"
#include "../firmware/src/upreset.c"
#include "../firmware/src/project.c"

enum { ED_BACKUP_LIST = 65, ED_BACKUP_GET, ED_BACKUP_PUT };
static uint8_t rep[4096];
static uint32_t rep_n;
static void ed_b(uint32_t v) { if (rep_n < sizeof rep) rep[rep_n++] = (uint8_t)(v & 127u); }
static uint32_t ed_unpack7(const uint8_t *a, uint32_t na, uint8_t *out, uint32_t max)
{
    uint32_t n = 0;
    while (na && n < max) {
        uint32_t m = *a++, j;
        na--;
        uint32_t k = na > 7u ? 7u : na;
        if (!k || n + k > max || (m >> k))
            return 0;
        for (j = 0; j < k; j++, na--)
            out[n++] = (uint8_t)(*a++ | ((m >> j) & 1u) << 7);
    }
    return na ? 0u : n;
}
static uint8_t ed_smp_buf[512] __attribute__((aligned(4)));
static void fm1_wdt_feed(void) {}
static int ed_flash_stop(void) { return transport_busy(); }
static void ed_str(const char *s, uint32_t max)
{
    uint32_t i;
    for (i = 0; s && s[i] && i < max; i++) ed_b((uint8_t)s[i]);
    ed_b(0);
}
#include "../firmware/src/editor_backup.c"

/* ------------------------------------------------------------------ output --- */
static void b64(const uint8_t *b, uint32_t n)
{
    static const char A[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    uint32_t i;
    putchar('"');
    for (i = 0; i < n; i += 3) {
        uint32_t v = (uint32_t)b[i] << 16 | (i + 1 < n ? (uint32_t)b[i + 1] << 8 : 0) | (i + 2 < n ? b[i + 2] : 0);
        putchar(A[v >> 18 & 63]);
        putchar(A[v >> 12 & 63]);
        putchar(i + 1 < n ? A[v >> 6 & 63] : '=');
        putchar(i + 2 < n ? A[v & 63] : '=');
    }
    putchar('"');
}
static void ints(const char *name, const int32_t *v, uint32_t n, int last)
{
    uint32_t i;
    printf("  %s: [", name);
    for (i = 0; i < n; i++)
        printf("%s%d", !i ? "" : i % 32u ? ", " : ",\n    ", v[i]);
    printf("]%s\n", last ? "" : ",");
}

/* ------------------------------------------------------------------ tables --- */
static int32_t fit_kind(const param_desc_t *d) { return d->names == N_DRUM_KIT ? 1 : d->names == N_FM6_PATCH ? 2 : 0; }
static void tables(const char *rev)
{
    static int32_t v[ENG_ID_MAX * 8u * 4u], w[256];
    uint32_t i, k;
    printf("// SPDX-License-Identifier: GPL-3.0-only\n// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments\n");
    printf("// Generated by gen_legacy.c from the Felucca firmware's tables (standard profile): do not edit. The parameter\n"
           "// descriptors, engine ids and constants the firmware's legacy conversions read (app/src/legacy.js).\n");
    printf("export const T = {\n");
    printf("  REVISION: \"%s\",\n", rev);
    printf("  P_COUNT: %u, P_E0: %u, G_COUNT: %u, NSTEP: %u, NTRK: %u, ENG_ID_MAX: %u, NENGINES: %u,\n",
           (unsigned)P_COUNT, (unsigned)P_E0, (unsigned)G_COUNT, (unsigned)NSTEP, (unsigned)NTRK, ENG_ID_MAX, (unsigned)NENGINES);
    printf("  P_LEVEL: %u, P_SUS: %u, P_REV: %u, P_FM1_ATK: %u, P_FM4_LEVEL: %u, P_SLEN: %u,\n", (unsigned)P_LEVEL,
           (unsigned)P_SUS, (unsigned)P_REV, (unsigned)P_FM1_ATK, (unsigned)P_FM4_LEVEL, (unsigned)P_SLEN);
    printf("  G_ROUTE: %u, G_RTYPE: %u, G_DRLVL: %u, G_DRREV: %u, ROUTE_TRACK: %u, MCH_N: %u,\n", (unsigned)G_ROUTE,
           (unsigned)G_RTYPE, (unsigned)G_DRLVL, (unsigned)G_DRREV, (unsigned)ROUTE_TRACK, MCH_N);
    printf("  ENGI_DIGITAL: %u, ENGI_SAMPLE: %u, ENGI_PHYS: %u, ENGI_DRUM: %u, ENGI_FM6: %u, NPART: %u,\n", ENGI_DIGITAL,
           ENGI_SAMPLE, ENGI_PHYS, ENGI_DRUM, (unsigned)ENGI_FM6, (unsigned)NPART);
    printf("  COND_LIMIT: %u, ST_REST: %u, MOTION_MAX: %u, FM6_PACKED: %u, FM6_OWN: %u, CHAIN_ROWS: %u, CHAIN_SILENT: %u,\n",
           COND_FIRST + NCOND, (unsigned)ST_REST, MOTION_MAX, FM6_PACKED, (unsigned)FM6_OWN, CHAIN_ROWS, CHAIN_SILENT);
    printf("  PROJ_DEF_KEEP: %u, PROJ_DEF_SOUND: %u, PROJ_PHYS: %u, UP_USED: %u, UP_VER: %u, UP_VER_GRID: %u, UP_PMAX: %u,\n",
           PROJ_DEF_KEEP, PROJ_DEF_SOUND, PROJ_PHYS, UP_USED, UP_VER, UP_VER_GRID, UP_PMAX);
    printf("  CAT_N: %u, PROJECT_T_SIZE: %u,\n", (unsigned)CAT_N, (unsigned)sizeof(project_t));
    for (i = 0; i < P_E0; i++) {
        v[i * 4u] = TP[i].min; v[i * 4u + 1u] = TP[i].max; v[i * 4u + 2u] = TP[i].def; v[i * 4u + 3u] = fit_kind(&TP[i]);
    }
    ints("TP", v, P_E0 * 4u, 0);
    printf("  // per engine id 0..63 (an id this build lacks: ENG_NONE's), its 8 EDIT values: min, max, def, fit\n");
    for (i = 0; i < ENG_ID_MAX; i++)
        for (k = 0; k < 8u; k++) {
            const param_desc_t *d = param_desc_of(eng_idx(i), P_E0 + k);
            int32_t *o = &v[(i * 8u + k) * 4u];
            o[0] = d->min; o[1] = d->max; o[2] = d->def; o[3] = fit_kind(d);
        }
    ints("EDIT", v, ENG_ID_MAX * 8u * 4u, 0);
    printf("  NAMES: [");
    for (i = 0; i < ENG_ID_MAX; i++)
        printf("%s\"%s\"", i ? ", " : "", eng_of(i)->name);
    printf("],\n");
    for (i = 0; i < ENG_ID_MAX; i++) w[i] = eng_ok(i);
    ints("ENG_OK", w, ENG_ID_MAX, 0);
    for (i = 0; i < ENG_ID_MAX; i++) w[i] = (int32_t)eng_idx(i) == 9 && eng_of(i) == &ENG_PHYS;
    ints("ENG_IS_PHYS", w, ENG_ID_MAX, 0);
    for (i = 0; i < DK_COUNT; i++) w[i] = DK_PLAYS[i];
    ints("DK_PLAYS", w, DK_COUNT, 0);
    for (i = 0; i < NTRK; i++) w[i] = (int32_t)trk_def_engine(i);
    ints("TRK_DEF_ENGINE", w, NTRK, 0);
    for (i = 0; i < FM6_PACKED; i++) w[i] = FM6_INIT[i];
    ints("FM6_INIT", w, FM6_PACKED, 0);
    for (i = 0; i < NLANE; i++) w[i] = DRUM_LANE_NOTE[i];
    ints("DRUM_LANE_NOTE", w, NLANE, 0);
    for (i = 0; i < 128u; i++) w[i] = (int32_t)drum_lane(i);
    ints("DRUM_LANE", w, 128u, 0);
    for (i = 0; i < 128u; i++) w[i] = motion_param(i);
    ints("MOTION_PARAM", w, 128u, 0);
    {
        static const int16_t KIT[8] = DRUM_KIT_E;
        for (i = 0; i < 8u; i++) w[i] = KIT[i];
        ints("DRUM_KIT_E", w, 8u, 1);
    }
    printf("};\n");
}

/* ------------------------------------------------------------- a random source --- */
static uint32_t rs = 1;
static uint32_t rnd(void) { rs ^= rs << 13; rs ^= rs >> 17; rs ^= rs << 5; return rs; }
static uint32_t rn(uint32_t n) { return rnd() % n; }
static int32_t rr(int32_t a, int32_t b) { return a + (int32_t)rn((uint32_t)(b - a + 1)); }
static void w16(uint8_t *b, uint32_t off, int32_t v) { b[off] = (uint8_t)v; b[off + 1] = (uint8_t)(v >> 8); }
static void w32(uint8_t *b, uint32_t off, uint32_t v) { memcpy(b + off, &v, 4); }
static void seal(uint8_t *b, uint32_t n) { w32(b, n - 4u, proj_hash(b, n - 4u)); }

/* a random stored value of an old int16 parameter (mostly in range, sometimes far out of it) */
static int16_t rpar(void)
{
    uint32_t k = rn(10);
    return (int16_t)(k < 6 ? rr(-64, 127) : k < 8 ? rr(-400, 400) : k < 9 ? rr(0, 20) : (int32_t)(int16_t)rnd());
}
/* a random engine id: mostly a known engine, the retired and converted ones often, sometimes one this build lacks */
static uint8_t reng(int allow_bad)
{
    static const uint8_t E[] = {0, 1, 1, 2, 3, 4, 4, 5, 6, 7, 8, 9, 9, 10, 10, 11, 12, 12, 13, 14, 20, 63};
    if (allow_bad && !rn(40)) return (uint8_t)rr(64, 255);
    return E[rn(sizeof E)];
}
/* E values of a track of engine e that hit the conversions: PHYS MODEL 2 / 4, SAMPLE PERC, DRUM KIT 1..3, FM6 SLOT */
static void rspecial(uint8_t e, int16_t *ev)
{
    if (e == ENGI_PHYS && rn(2)) ev[0] = (int16_t)rr(0, 4);
    if (e == ENGI_SAMPLE && rn(2)) ev[0] = 4;
    if (e == ENGI_DRUM && rn(2)) ev[0] = (int16_t)rr(0, 12);
    if (e == ENGI_DIGITAL && rn(2)) ev[0] = (int16_t)rr(0, 9);
}

static uint32_t g_ok_route(int16_t *g)
{
    uint32_t i;
    for (i = 0; i < G_COUNT; i++) g[i] = rpar();
    if (!rn(3)) g[G_ROUTE] = ROUTE_TRACK;
    if (!rn(3)) g[G_RTYPE] = (int16_t)rr(-2, 20);
    return 0;
}
/* an int16 project of formats 1..6: header and globals at b */
static void rhead16(uint8_t *b, uint32_t magic, uint32_t size, int v2)
{
    int16_t g[G_COUNT];
    uint32_t i;
    memset(b, 0, size);
    w32(b, 0, magic);
    w32(b, 4, size);
    g_ok_route(g);
    for (i = 0; i < G_COUNT; i++) w16(b, 8 + 2 * i, g[i]);
    b[62] = (uint8_t)rn(4);
    if (!v2) {
        b[63] = rn(2) ? NPART : (uint8_t)(rn(3) ? 0 : rn(256));
        b[64] = (uint8_t)(rn(3) ? rn(3) : rn(256));
        b[65] = (uint8_t)rn(256);
    } else {
        b[63] = (uint8_t)rn(256); b[64] = (uint8_t)rn(256); b[65] = (uint8_t)rn(256);
    }
}
/* a track of an int16 format at b: np values, engine, preset, steps of `ss` bytes (8 or 10), lanes `ln` bytes */
static uint32_t rtrk16(uint8_t *b, uint32_t np, uint32_t ss, uint32_t ln, int allow_bad)
{
    uint32_t i, j, pos = 0;
    uint8_t e = reng(allow_bad);
    int16_t p[128];
    for (i = 0; i < np; i++) p[i] = rpar();
    rspecial(e, &p[np - 8u]);
    for (i = 0; i < np; i++, pos += 2) w16(b, pos, p[i]);
    b[pos++] = e;
    b[pos++] = (uint8_t)(rn(5) ? rn(12) : rn(256));
    for (i = 0; i < NSTEP; i++) {
        uint8_t *s = b + pos;
        for (j = 0; j < 4u; j++) s[j] = (uint8_t)(rn(3) ? rr(30, 60) : rn(256));
        s[4] = (uint8_t)(rn(6) ? rn(5) : rn(256));
        s[5] = (uint8_t)(rn(6) ? rn(3) : rn(256));
        s[6] = (uint8_t)rn(256);
        s[7] = (uint8_t)rn(256);
        if (ss == 10u) { s[8] = (uint8_t)rn(256); s[9] = (uint8_t)rn(256); }
        pos += ss;
    }
    for (i = 0; i < ln; i++) b[pos++] = (uint8_t)rn(256);
    return pos;
}
static void rchain9(uint8_t *b, int bad)
{
    uint32_t i, n = rn(17);
    memset(b, 0, 36);
    b[0] = (uint8_t)n;
    b[1] = (uint8_t)rn(256); b[2] = (uint8_t)rn(256); b[3] = (uint8_t)rn(256);
    for (i = 0; i < CHAIN_ROWS; i++) {
        b[4 + 2 * i] = (uint8_t)(i < n ? rn(4) : rn(256));
        b[5 + 2 * i] = (uint8_t)(i < n ? rr(1, 16) : rn(256));
    }
    if (bad && n) b[5] = 0;
}
static uint32_t rformat_old(uint8_t *b, uint32_t fmt)   /* FUN1..FUN6 -> its length */
{
    uint32_t t, pos, n;
    switch (fmt) {
    case 1: n = sizeof(project_v1_t); rhead16(b, PROJ_MAGIC_V1, n, 1); rtrk16(b + 62, PROJ_NP_V2, 8, 0, 0); break;
    case 2: n = sizeof(project_v2_t); rhead16(b, PROJ_MAGIC_V2, n, 1);
        for (t = 0, pos = 66; t < NTRK; t++) pos += rtrk16(b + pos, PROJ_NP_V2, 8, 0, 1);
        break;
    case 3: n = sizeof(project_v3_t); rhead16(b, PROJ_MAGIC_V3, n, 0); b[64] = (uint8_t)rn(256);
        for (t = 0, pos = 66; t < NTRK; t++) pos += rtrk16(b + pos, PROJ_NP_V3, 8, 0, 1);
        break;
    case 4: n = sizeof(project_v4_t); rhead16(b, PROJ_MAGIC_V4, n, 0);
        for (t = 0, pos = 66; t < NTRK; t++) pos += rtrk16(b + pos, PROJ_NP_V4, 8, 0, 1);
        break;
    default:
        n = fmt == 5 ? sizeof(project_v5_t) : sizeof(project_v6_t);
        rhead16(b, fmt == 5 ? PROJ_MAGIC_V5 : PROJ_MAGIC_V6, n, 0);
        for (t = 0, pos = 66; t < NTRK; t++) pos += rtrk16(b + pos, 69, 10, 40, 1);
        if (fmt == 6) rchain9(b + pos, !rn(20));
        break;
    }
    seal(b, n);
    return n;
}
/* FUN7..FUN10 as their proj_pack wrote them (np parameters), with random valid content */
static uint32_t rformat_new(uint8_t *b, uint32_t magic, uint32_t np)
{
    uint32_t st = magic == PROJ_MAGIC ? PROJ_STORE_SIZE : magic == PROJ_MAGIC_V9 ? PROJ_STORE_V9 :
                  magic == PROJ_MAGIC_V8 ? PROJ_STORE_V8 : PROJ_STORE_V7;
    int v10 = magic == PROJ_MAGIC, v7 = magic == PROJ_MAGIC_V7;
    uint32_t pos = 68, t, i, j, name = st - 16u, nm;
    int16_t g[G_COUNT];
    memset(b, 0, st);
    w32(b, 0, magic);
    w32(b, 4, st);
    g_ok_route(g);
    if (!v7) g[G_RTYPE] = (int16_t)rr(0, 2);
    for (i = 0; i < G_COUNT; i++) w16(b, 8 + 2 * i, g[i]);
    b[62] = (uint8_t)rn(4);
    b[63] = rn(4) ? NPART : 0;
    b[64] = rn(3) ? PROJ_PHYS : (uint8_t)rn(3);
    b[65] = (uint8_t)rn(256);
    b[66] = (uint8_t)np;
    b[67] = (uint8_t)rn(256);
    for (t = 0; t < NTRK; t++) {
        uint8_t e = reng(0);
        int16_t p[128];
        for (i = 0; i < np; i++) p[i] = (int16_t)(rn(8) ? rr(-64, 127) : rr(-64, 2));
        rspecial(e, &p[np - 8u]);
        for (i = 0; i < np; i++) b[pos++] = (uint8_t)(p[i] + 64);
        b[pos++] = e;
        b[pos++] = (uint8_t)(rn(5) ? rn(12) : rn(256));
        for (i = 0; i < NSTEP; i++) {
            uint8_t *s = b + pos;
            uint32_t hit = rn(3) ? 0u : rn(256), r = rn(4);
            for (j = 0; j < 4u; j++) s[j] = (uint8_t)((rn(3) ? rr(30, 60) : rn(128)) | (v10 && !rn(4) ? 128u : 0u));
            s[4] = (uint8_t)(rn(5) | rn(3) << 3 | rn(4) << 5);
            s[5] = (uint8_t)(rn(128) | (r & 1u) << 7);
            s[6] = (uint8_t)hit;
            s[7] = (uint8_t)(hit & rn(256));
            s[8] = (uint8_t)((rn(3) ? 0u : rn(COND_FIRST + NCOND)) | (r >> 1) << 7);
            pos += 9;
        }
    }
    if (v10) {                                            /* chain_config_t, rows past count anything */
        uint32_t n = rn(17);
        b[pos] = (uint8_t)n;
        for (i = 1; i < 84u; i++) b[pos + i] = (uint8_t)rn(256);
        for (i = 0; i < n; i++) {
            for (j = 0; j < 4u; j++) b[pos + 4 + 5 * i + j] = (uint8_t)rn(5);
            b[pos + 8 + 5 * i] = (uint8_t)rr(1, 16);
        }
        pos += 84;
    } else {
        rchain9(b + pos, 0);
        pos += 36;
    }
    {   /* the motion block: valid, unique (place, id); FUN7..9: 64 x 4 bytes, FUN10: 128 x 3 */
        uint32_t max = v10 ? 128u : 64u, n = rn(4) ? rn(max + 1u) : 0u, es = v10 ? 3u : 4u, k = 0, tries = 0;
        uint32_t blk = v10 ? 388u : 260u;
        for (i = 4; i < blk; i++) b[pos + i] = (uint8_t)rn(256);
        b[pos + 1] = (uint8_t)rn(16);
        b[pos + 2] = (uint8_t)rn(256);
        b[pos + 3] = (uint8_t)rn(256);
        while (k < n && tries++ < 10000u) {
            uint32_t place = rn(256), id = rn(np), today = id >= np - 8u ? id + P_COUNT - np : id, q;
            int dup = 0;
            if (!motion_param(today)) continue;
            for (q = 0; q < k; q++)
                if (b[pos + 4 + es * q] == place && (b[pos + 5 + es * q] & 127u) == id) dup = 1;
            if (dup) continue;
            b[pos + 4 + es * k] = (uint8_t)place;
            b[pos + 5 + es * k] = (uint8_t)(id | (rn(4) ? 0u : 128u));
            if (v10) b[pos + 6 + es * k] = (uint8_t)(int8_t)rr(-64, 127);
            else w16(b, pos + 6 + es * k, rr(-64, 127));
            k++;
        }
        b[pos] = (uint8_t)k;
        pos += blk;
    }
    if (!v7)
        for (i = 0; i < NTRK * FM6_PACKED; i++) b[name - NTRK * FM6_PACKED + i] = (uint8_t)(rn(2) ? rn(100) : rn(256));
    if (v10) {
        uint32_t m = rnd() & 0xFFFFFFu;
        b[PROJ_MIDI_OFF] = (uint8_t)m; b[PROJ_MIDI_OFF + 1] = (uint8_t)(m >> 8); b[PROJ_MIDI_OFF + 2] = (uint8_t)(m >> 16);
    }
    nm = rn(4);
    for (i = 0; i < PROJ_NAME_LEN; i++)
        b[name + i] = nm == 0 ? 0 : nm == 1 ? (uint8_t)rr('A', 'Z') : nm == 2 ? (uint8_t)rr(' ', 'z') :
                      (uint8_t)(i == 3 ? 7 : 'Q');
    if (nm == 1 && rn(2)) b[name + 6] = 0;
    seal(b, st);
    return pos <= (v7 ? name : name - NTRK * FM6_PACKED) ? st : 0;
}

/* ------------------------------------------------------------- the fixtures --- */
/* tests/project_test.c: oldv / fill_v2_track (FUN2 / FUN1), oldv3 / fill_v3_track (FUN3) */
static int16_t oldv(uint32_t t, uint32_t k) { return (int16_t)(t * 100u + k * 3u + 1u); }
static const uint8_t OLD_ENG[NTRK] = {7, 0, 6, 0};
static void fill_v2_track(proj_trk_v2_t *d, uint32_t t)
{
    uint32_t k;
    for (k = 0; k < PROJ_NP_V2; k++)
        d->p[k] = oldv(t, k);
    d->engine = OLD_ENG[t];
    d->preset = (uint8_t)(t + 5u);
    for (k = 0; k < NSTEP; k++) {
        step8_t *s = &d->step[k];
        s->note[0] = (uint8_t)(36u + (k + t) % 40u);
        s->n = (uint8_t)(k % 3u);
        s->time = (uint8_t)(k % 3u);
        s->flags = (uint8_t)(k & 3u);
        s->vel = (uint8_t)(64u + t);
    }
}
static int16_t oldv3(uint32_t t, uint32_t k) { return (int16_t)(t * 200u + k * 5u + 3u); }
static void fill_v3_track(proj_trk_v3_t *d, uint32_t t)
{
    uint32_t k;
    for (k = 0; k < PROJ_NP_V3; k++)
        d->p[k] = oldv3(t, k);
    d->engine = (uint8_t)(t * 3u);
    d->preset = (uint8_t)(t + 1u);
    for (k = 0; k < NSTEP; k++) {
        step8_t *s = &d->step[k];
        s->note[0] = (uint8_t)(40u + (k * 7u + t) % 40u);
        s->n = (uint8_t)((k + t) % 3u);
        s->time = (uint8_t)(k % 3u);
        s->flags = (uint8_t)((k + 1u) & 3u);
        s->vel = (uint8_t)(70u + t);
    }
}

static int first_vec = 1;
static void vec_project(const char *name, const char *source, const uint8_t *in, uint32_t n)
{
    st_hdr_t h;
    int ok;
    uint32_t state;
    memset(nor, 0xFF, sizeof nor);
    memset(proj_slot, 0, sizeof proj_slot);
    if (st_save(OBJ_PROJECT0, in, n)) { fprintf(stderr, "st_save failed\n"); exit(1); }
    (void)ed_raw_pick(OBJ_PROJECT0, &h, &ok);
    state = ed_raw_kind(OBJ_PROJECT0, st_buf, h.len);
    proj_fetch(0);
    printf("%s    {\"name\": \"%s\", \"source\": \"%s\", \"state\": %u,\n     \"in\": ", first_vec ? "" : ",\n", name, source, state);
    b64(in, n);
    printf(",\n     \"out\": ");
    if (proj_slot[0].raw[0] || proj_slot[0].raw[1] || proj_slot[0].raw[2] || proj_slot[0].raw[3])
        b64(proj_slot[0].raw, PROJ_STORE_SIZE);
    else
        printf("null");
    printf("}");
    first_vec = 0;
}

/* the firmware's UP_GET reply of record r sent back as UP_PUT (editor.c ED_UP_GET / ED_UP_PUT) -> *out; 0 done, 1 its
 * UP_PUT refused (the record stays as it is). The category byte goes along when the record holds one */
static int up_round_trip(const up_rec_t *r, up_rec_t *out)
{
    uint8_t a[400];
    uint32_t na = 0, i, slot;
    int16_t v[P_COUNT];
    up_values(r, v);
    a[na++] = 0;
    a[na++] = r->engine & 127u;
    for (i = 0; i < 12u && r->name[i]; i++) a[na++] = (uint8_t)r->name[i] & 127u;
    a[na++] = 0;
    for (i = 0; i < P_COUNT; i++) {
        uint32_t u = (uint32_t)(clamp(v[i], -8192, 8191) + 8192);
        a[na++] = (uint8_t)(u & 127u);
        a[na++] = (uint8_t)(u >> 7 & 127u);
    }
    for (i = 0; i < 16u; i++) { a[na++] = r->note[i] & 0x7Fu; a[na++] = r->flags[i] & 0x7Fu; }
    a[na++] = (uint8_t)up_grid(r);
    for (i = 0; i < 16u; i++) a[na++] = up_grid(r) ? (uint8_t)((r->note[i] >> 7) | (r->flags[i] >> 7) << 1) : 0u;
    if (r->ver >= 4u && r->np <= UP_CAT_AT && r->packed[UP_CAT_AT] && r->packed[UP_CAT_AT] < CAT_N)
        a[na++] = r->packed[UP_CAT_AT];
    if (up_parse(a, na, out, &slot))
        return 1;
    up_values(out, v);
    for (i = 0; i < P_COUNT; i++)
        up_set_value(out, i, v[i]);
    return 0;
}
/* the records this conversion rewrites: valid, an older version or parameter count, an engine UP_PUT takes */
static int up_legacy(const up_rec_t *r)
{
    return up_valid(r) && (r->ver < UP_VER || r->np < P_COUNT) && r->np <= P_COUNT && UP_PUT_ENGINE_OK(r->engine);
}
static void vec_bank(const char *name, const char *source, const uint8_t *in, uint32_t n)
{
    st_hdr_t h;
    int ok, len;
    uint32_t state, i;
    memset(nor, 0xFF, sizeof nor);
    memset(up_bank, 0, sizeof up_bank);
    if (st_save(OBJ_UPRESET0, in, n)) { fprintf(stderr, "st_save failed\n"); exit(1); }
    (void)ed_raw_pick(OBJ_UPRESET0, &h, &ok);
    state = ed_raw_kind(OBJ_UPRESET0, st_buf, h.len);
    len = st_load(OBJ_UPRESET0, &up_bank[0], sizeof up_bank[0]);
    up_bank_check(0, len);
    printf("%s    {\"name\": \"%s\", \"source\": \"%s\", \"state\": %u, \"refused\": [", first_vec ? "" : ",\n", name, source, state);
    {
        int first = 1;
        for (i = 0; state == ED_RAW_CURRENT && i < UP_PER_BANK; i++) {
            up_rec_t *r = &up_bank[0].r[i], o;
            if (!up_legacy(r))
                continue;
            if (up_round_trip(r, &o)) { printf("%s%u", first ? "" : ", ", i); first = 0; }
            else *r = o;
        }
    }
    printf("],\n     \"in\": ");
    b64(in, n);
    printf(",\n     \"out\": ");
    if (state == ED_RAW_CURRENT)
        b64((const uint8_t *)&up_bank[0], sizeof up_bank[0]);
    else
        printf("null");
    printf("}");
    first_vec = 0;
}

/* a user preset record: version ver, engine e, np parameters (int16 for 1..3, at most UP_PMAX; bytes for 4 / 5) */
static void rec_make(up_rec_t *r, uint32_t ver, uint8_t e, uint32_t np, const char *name, int wide)
{
    uint32_t i;
    int16_t p[144];
    memset(r, 0, sizeof *r);
    r->used = UP_USED;
    r->ver = (uint8_t)ver;
    r->engine = e;
    r->np = (uint8_t)np;
    for (i = 0; i < 12u && name[i]; i++) r->name[i] = name[i];
    for (i = 0; i < np; i++) p[i] = (int16_t)(ver >= 4u || !wide ? rr(-64, 127) : rpar());
    rspecial(e, &p[np - 8u]);
    for (i = 0; i < np; i++) {
        if (ver >= 4u) r->packed[i] = (uint8_t)(p[i] + 64);
        else r->p[i] = p[i];
    }
    if (ver >= 4u && rn(2)) r->packed[UP_CAT_AT] = (uint8_t)rn(CAT_N + 2u);
    for (i = 0; i < 16u; i++) {
        r->note[i] = (uint8_t)(rn(3) ? rr(30, 70) : rn(256));
        r->flags[i] = (uint8_t)rn(256);
    }
}
static void bank_random(up_bank_t *bk, int fixed)
{
    static const uint8_t NPS[] = {53, 57, 69, 89, 91, 99, 103, 104, 111};
    static const char *const NAMES[] = {"BASS 1", "lead", "PAD SLOW", "A", "KEYS 0123456", "DRUMS"};
    uint32_t i;
    memset(bk, 0, sizeof *bk);
    bk->magic = UP_BANK_MAGIC;
    bk->rsize = sizeof(up_rec_t);
    bk->nslot = UP_PER_BANK;
    for (i = 0; i < UP_PER_BANK; i++) {
        up_rec_t *r = &bk->r[i];
        uint32_t ver = fixed ? 0u : (uint32_t)rr(1, 5), np = NPS[rn(sizeof NPS)];
        if (!fixed && !rn(6)) { memset(r, 0, sizeof *r); continue; }
        if (!fixed) {
            if (ver < 4u && np > UP_PMAX) np = 69;
            rec_make(r, ver, reng(0), np, NAMES[rn(6)], 1);
            if (!rn(12)) r->ver = 6;                          /* a later record version: inert */
            if (!rn(12)) r->name[1] = 5;                      /* a name UP_PUT refuses */
        }
    }
    if (!fixed)
        return;
    rec_make(&bk->r[0], 1, ENGI_PHYS, 53, "OLD DUST", 0);          /* version 1: PHYS MODEL 2 was DUST */
    bk->r[0].p[45] = 2;
    rec_make(&bk->r[1], 2, 0, 53, "ANALOG 53", 1);                 /* 1.0: 53 parameters */
    rec_make(&bk->r[2], 2, 3, 69, "phase 69", 1);                  /* the matrix era */
    rec_make(&bk->r[3], 3, ENGI_DRUM, 60, "GRID 60", 0);           /* version 3: a drum grid */
    rec_make(&bk->r[4], 4, 5, 104, "VOICE 104", 0);                /* 1.2 .. 1.4: 104, a category */
    bk->r[4].packed[UP_CAT_AT] = 3;
    rec_make(&bk->r[5], 5, ENGI_DRUM, 99, "GRID 99", 0);           /* version 5 (grid) of 1.1 */
    rec_make(&bk->r[6], 2, ENGI_PHYS, 69, "PHYS DRUM", 0);         /* PHYS MODEL 4: DRUM */
    bk->r[6].p[61] = 4; bk->r[6].p[68] = 100; bk->r[6].p[67] = 90;
    rec_make(&bk->r[7], 2, ENGI_SAMPLE, 57, "PERC", 0);            /* SAMPLE SET 4 (PERC): DRUM */
    bk->r[7].p[49] = 4;
    rec_make(&bk->r[8], 2, ENGI_DIGITAL, 69, "DIGI", 0);           /* DIGITAL: kept as DIGITAL */
    rec_make(&bk->r[9], 4, ENGI_FM6, 99, "FM6 99", 0);             /* FM6 (its UPF6 link: tag) */
    rec_make(&bk->r[10], 2, 20, 69, "LATER ENG", 0);               /* an engine this build lacks */
    rec_make(&bk->r[11], 4, 7, P_COUNT, "CURRENT", 0);             /* already current */
    rec_make(&bk->r[12], 6, 2, P_COUNT, "FUTURE", 0);              /* a later version: inert */
    rec_make(&bk->r[13], 2, 6, 69, "BAD\x01NAME", 0);              /* UP_PUT refuses its name */
    rec_make(&bk->r[14], 2, ENGI_DRUM, 69, "KIT 2", 0);            /* a retired DRUM KIT (2: plays 10) */
    bk->r[14].p[61] = 2;
    rec_make(&bk->r[15], 2, 0, 57, "WIDE", 1);                     /* values far out of range */
    bk->r[15].p[0] = 1000; bk->r[15].p[1] = -1000;
}

static void vectors(void)
{
    static uint8_t b[4096];
    static project_v1_t v1;
    static project_v2_t v2;
    static project_v3_t v3;
    static project_v4_t v4;
    static up_bank_t bk;
    uint32_t i, t, n, f, k;
    char nm[64];
    printf("{\n  \"generator\": \"gen_legacy.c\",\n  \"P_COUNT\": %u,\n  \"projects\": [\n", (unsigned)P_COUNT);

    /* tests/project_test.c: FUN2 (g 500.., sel 2, WHEEL ANALOG TRIO and the drum part) */
    memset(&v2, 0, sizeof v2);
    v2.magic = PROJ_MAGIC_V2; v2.size = sizeof v2;
    for (i = 0; i < PROJ_NG_V2; i++) v2.g[i] = (int16_t)(500 + i);
    v2.sel = 2;
    for (t = 0; t < NTRK; t++) fill_v2_track(&v2.t[t], t);
    v2.sum = proj_hash(&v2, sizeof v2 - 4u);
    vec_project("FUN2 (1.0 before: GM drum part, WHEEL ANALOG TRIO)", "project_test.c FUN2", (const uint8_t *)&v2, sizeof v2);
    /* FUN1: its one instrument (the FUN2 fixture's track 1) */
    memset(&v1, 0, sizeof v1);
    v1.magic = PROJ_MAGIC_V1; v1.size = sizeof v1;
    for (i = 0; i < PROJ_NG_V2; i++) v1.g[i] = (int16_t)(500 + i);
    fill_v2_track(&v1.t, 0);
    v1.sum = proj_hash(&v1, sizeof v1 - 4u);
    vec_project("FUN1 (one instrument; tracks 2..4 power-on sounds)", "project_test.c fill_v2_track", (const uint8_t *)&v1, sizeof v1);
    /* FUN3 with parts NPART, then before 1.0 (parts 0, drum level 90, reverb 20) */
    memset(&v3, 0, sizeof v3);
    v3.magic = PROJ_MAGIC_V3; v3.size = sizeof v3;
    for (i = 0; i < G_COUNT; i++) v3.g[i] = (int16_t)(600 + i);
    v3.sel = 3; v3.parts = NPART;
    for (t = 0; t < NTRK; t++) fill_v3_track(&v3.t[t], t);
    v3.sum = proj_hash(&v3, sizeof v3 - 4u);
    vec_project("FUN3 (1.0: four parts, the SLICER)", "project_test.c FUN3", (const uint8_t *)&v3, sizeof v3);
    v3.parts = 0; v3.t[3] = v3.t[0]; v3.t[3].engine = 0; v3.t[3].preset = 0; v3.g[G_DRLVL] = 90; v3.g[G_DRREV] = 20;
    v3.sum = proj_hash(&v3, sizeof v3 - 4u);
    vec_project("FUN3 before 1.0 (drum part: LEVEL / REV from G_DRLVL / G_DRREV)", "project_test.c FUN3 parts 0", (const uint8_t *)&v3, sizeof v3);
    v3.sum ^= 1u;
    vec_project("FUN3 with a damaged hash (refused)", "project_test.c (damaged checksum)", (const uint8_t *)&v3, sizeof v3);
    /* FUN4: PHYS (phys 1: MODEL 4 was DRUM), a DRUM track with lane notes, a low tom, a crash, an accent, a TIE */
    memset(&v4, 0, sizeof v4);
    v4.magic = PROJ_MAGIC_V4; v4.size = sizeof v4;
    for (i = 0; i < G_COUNT; i++) v4.g[i] = (int16_t)(10 + i);
    v4.sel = 1; v4.parts = NPART; v4.phys = 1;
    for (t = 0; t < NTRK; t++) {
        for (k = 0; k < PROJ_NP_V4; k++) v4.t[t].p[k] = (int16_t)((t * 13u + k * 7u) % 120u);
        v4.t[t].engine = (uint8_t)(t == 0 ? ENGI_PHYS : t == 1 ? ENGI_DRUM : t == 2 ? ENGI_PHYS : 2);
        v4.t[t].preset = (uint8_t)t;
    }
    v4.t[0].p[61] = 4; v4.t[0].p[67] = 100; v4.t[0].p[68] = 70;     /* PHYS MODEL 4 = DRUM: KICK 100, PERC 70 */
    v4.t[2].p[61] = 2;                                              /* MODEL 2 with phys 1: kept (not DUST) */
    {
        static const step8_t D[6] = {
            {{36, 0, 0, 0}, 1, ST_NOTE, SF_ACCENT, 96}, {{42, 38, 0, 0}, 2, ST_NOTE, 0, 100},
            {{41, 36, 0, 0}, 2, ST_NOTE, SF_ACCENT, 96}, {{49, 0, 0, 0}, 1, ST_NOTE, 0, 96},
            {{36, 0, 0, 0}, 1, ST_TIE, 0, 96}, {{46, 39, 37, 56}, 4, ST_NOTE, SF_ACCENT | SF_SLIDE, 90}};
        for (k = 0; k < 6u; k++) { v4.t[1].step[k] = D[k]; v4.t[0].step[k] = D[k]; }
    }
    v4.sum = proj_hash(&v4, sizeof v4 - 4u);
    vec_project("FUN4 (phys 1: PHYS MODEL 4 -> DRUM, lane notes -> grid)", "project_test.c FUN4 drum steps", (const uint8_t *)&v4, sizeof v4);
    v4.phys = 0;                                                    /* before 1.0: MODEL 2 = DUST, MODEL 4 kept PHYS */
    v4.sum = proj_hash(&v4, sizeof v4 - 4u);
    vec_project("FUN4 (phys 0: PHYS DUST -> MODAL bowed)", "project_test.c phys 0", (const uint8_t *)&v4, sizeof v4);

    /* hand-made cases on the newer formats: DIGITAL, SAMPLE PERC, retired KIT, FM6 bank SLOT, np 103 / 104 */
    for (f = 0; f < 6u; f++) {
        static const uint32_t MG[6] = {PROJ_MAGIC_V7, PROJ_MAGIC_V7, PROJ_MAGIC_V8, PROJ_MAGIC_V9, PROJ_MAGIC, PROJ_MAGIC};
        static const uint32_t NP[6] = {89, 91, 91, 99, 103, 104};
        static const char *const NM[6] = {"FUN7 np 89 (before the chord keys)", "FUN7 np 91", "FUN8 np 91 (1.0.x)",
            "FUN9 np 99 (1.1)", "FUN10 np 103 (1.2 before SPREAD)", "FUN10 np 104 (1.2 .. 1.4)"};
        static const char *const SRC[6] = {"old_pack.h FUN7", "old_pack.h FUN7", "old_pack.h FUN8", "old_pack.h FUN9",
            "fun10_test.c np 103", "fun10_test.c np 104"};
        uint32_t np = NP[f], e0;
        rs = 1000u + f;
        n = rformat_new(b, MG[f], np);
        e0 = 68;
        /* track 1 DIGITAL (E.PIANO's values), track 2 SAMPLE PERC, track 3 DRUM KIT 2, track 4 FM6 SLOT 20 */
        {
            static const int8_t EP[8] = {4, 1, 1, 14, 70, 55, 0, 0};
            uint32_t tl = np + 2u + NSTEP * 9u;
            for (k = 0; k < 8u; k++) b[e0 + np - 8u + k] = (uint8_t)(EP[k] + 64);
            b[e0 + 1] = 64; b[e0 + 2] = 64 + 80; b[e0 + 3] = 64 + 40; b[e0 + 4] = 64 + 60;
            b[e0 + np] = ENGI_DIGITAL; b[e0 + np + 1] = 0;
            b[e0 + tl + np - 8u] = 64 + 4; b[e0 + tl + np] = ENGI_SAMPLE;
            b[e0 + 2 * tl + np - 8u] = 64 + 2; b[e0 + 2 * tl + np] = ENGI_DRUM;
            b[e0 + 3 * tl + np] = (uint8_t)ENGI_FM6;
            for (k = 0; k < 8u; k++) b[e0 + 3 * tl + np - 8u + k] = 64 + 20;
        }
        seal(b, n);
        vec_project(NM[f], SRC[f], b, n);
    }
    /* refusals: FUN10 of more parameters than P_COUNT, an engine byte past the id space, a nudge bit in FUN9 */
    rs = 77;
    n = rformat_new(b, PROJ_MAGIC, 111);
    b[66] = (uint8_t)(P_COUNT + 1u);
    seal(b, n);
    vec_project("FUN10 np 112 (a later firmware's: refused)", "fun10_test.c (more parameters)", b, n);
    rs = 78;
    n = rformat_new(b, PROJ_MAGIC_V9, 99);
    b[68] |= 0;
    b[68 + 99 + 2] |= 128u;
    seal(b, n);
    vec_project("FUN9 with a nudge bit (refused)", "fun10_test.c (nudge bit)", b, n);
    rs = 79;
    n = rformat_old(b, 6);
    b[66 + 138] = 70;
    seal(b, n);
    vec_project("FUN6 with engine byte 70 (refused)", "engid_test.c (engine past the id space)", b, n);

    /* the corpus: every format, seeded */
    for (f = 1; f <= 12u; f++)
        for (k = 0; k < 1u; k++) {
            rs = 0x9E3779B9u ^ (f * 7919u + k * 104729u);
            if (f <= 6u) n = rformat_old(b, f);
            else n = rformat_new(b, f == 7u ? PROJ_MAGIC_V7 : f == 8u ? PROJ_MAGIC_V8 : f == 9u ? PROJ_MAGIC_V9 : PROJ_MAGIC,
                                 f == 7u ? (k ? 91u : 89u) : f == 8u ? 91u : f == 9u ? 99u : f == 10u ? 103u : f == 11u ? 104u : P_COUNT);
            if (!n) continue;
            snprintf(nm, sizeof nm, "corpus %s #%u", f <= 9u ? (const char *[]){"", "FUN1", "FUN2", "FUN3", "FUN4", "FUN5",
                     "FUN6", "FUN7", "FUN8", "FUN9"}[f] : f == 10u ? "FUN10 np 103" : f == 11u ? "FUN10 np 104" : "FUN10 np 111", k);
            vec_project(nm, "gen_legacy.c corpus", b, n);
        }
    printf("\n  ],\n  \"presets\": [\n");
    first_vec = 1;
    rs = 4242;
    bank_random(&bk, 1);
    vec_bank("bank of every record kind (versions 1..6, retired sounds, refusals)", "upreset_test.c record versions",
             (const uint8_t *)&bk, sizeof bk);
    bk.nslot = 15;
    vec_bank("bank of another shape (UNKNOWN: refused)", "upreset_test.c (bank shape)", (const uint8_t *)&bk, sizeof bk);
    for (k = 0; k < 2u; k++) {
        rs = 0x51ED270Bu + k * 977u;
        bank_random(&bk, 0);
        snprintf(nm, sizeof nm, "corpus bank #%u", k);
        vec_bank(nm, "gen_legacy.c corpus", (const uint8_t *)&bk, sizeof bk);
    }
    printf("\n  ]\n}\n");
}

/* `corpus SEED COUNT`: COUNT more seeded projects of every format and COUNT / 8 banks (not committed: test_legacy.mjs
 * compares them in place when FELUCCA_ROOT is set) */
static void corpus(uint32_t seed, uint32_t count)
{
    static uint8_t b[4096];
    static up_bank_t bk;
    uint32_t k, f, n;
    char nm[64];
    printf("{\n  \"generator\": \"gen_legacy.c corpus\",\n  \"projects\": [\n");
    for (k = 0; k < count; k++) {
        f = 1u + k % 12u;
        rs = (seed * 2654435761u) ^ (k * 40503u + 1u);
        if (!rs) rs = 1;
        if (f <= 6u) n = rformat_old(b, f);
        else n = rformat_new(b, f == 7u ? PROJ_MAGIC_V7 : f == 8u ? PROJ_MAGIC_V8 : f == 9u ? PROJ_MAGIC_V9 : PROJ_MAGIC,
                             f == 7u ? (k & 16u ? 91u : 89u) : f == 8u ? 91u : f == 9u ? 99u : f == 10u ? 103u : f == 11u ? 104u : P_COUNT);
        if (!n) continue;
        snprintf(nm, sizeof nm, "seed %u #%u", seed, k);
        vec_project(nm, "gen_legacy.c corpus", b, n);
    }
    printf("\n  ],\n  \"presets\": [\n");
    first_vec = 1;
    for (k = 0; k < count / 8u + 1u; k++) {
        rs = (seed * 2246822519u) ^ (k * 3266489917u + 7u);
        if (!rs) rs = 1;
        bank_random(&bk, 0);
        snprintf(nm, sizeof nm, "seed %u bank #%u", seed, k);
        vec_bank(nm, "gen_legacy.c corpus", (const uint8_t *)&bk, sizeof bk);
    }
    printf("\n  ]\n}\n");
}

int main(int argc, char **argv)
{
    memset(nor, 0xFF, sizeof nor);
    host_tracks_init();
    if (argc > 1 && !strcmp(argv[1], "tables"))
        tables(argc > 2 ? argv[2] : "unknown");
    else if (argc > 1 && !strcmp(argv[1], "vectors"))
        vectors();
    else if (argc > 1 && !strcmp(argv[1], "classify")) {
        uint8_t b[3840];
        uint32_t n = (uint32_t)fread(b, 1, sizeof b, stdin);
        printf("%u\n", ed_raw_kind(OBJ_PROJECT0, b, n));
    }
    else if (argc > 3 && !strcmp(argv[1], "corpus"))
        corpus((uint32_t)strtoul(argv[2], 0, 0), (uint32_t)strtoul(argv[3], 0, 0));
    else {
        fprintf(stderr, "usage: gen_legacy tables [REVISION] | vectors | classify < project.bin | corpus SEED COUNT\n");
        return 2;
    }
    return 0;
}
