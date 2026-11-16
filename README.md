# Temettü Takvimi

ABD ve BIST hisse / ETF / fonlarının hangi ay ne kadar temettü ödeyeceğini gösteren kişisel sayfa.

- Arama kutusundan sembol bul (KO, SCHD, TUPRS…), adet ve ilk alış tarihini gir.
- Takvim: her ay hangi kalemin ödeme yaptığı ve net tutarı (stopaj düşülmüş).
- Kartlar: adet (tıklayıp değiştirilebilir), alınan temettü, yıllık beklenen ve verim.
- Grafik: aylık alınan / beklenen temettü ve günlük gelişim (yıllık gelir + toplam alınan).

Stopaj her ödemenin tarihindeki yasal orana göre otomatik uygulanır (`app.js` içindeki `TAX_RULES` tablosu):
BIST %15 (22.12.2024 öncesi %10), BIST'teki GYO ve diğer yatırım ortaklıkları %0, ABD %20 (W-8BEN ile).

Adet değiştikçe o günün tarihiyle kaydedilir, böylece geçmiş günler bozulmaz. Veriler yalnızca tarayıcıda
(localStorage) tutulur; cihaz değiştirirken **Ayarlar → Yedeği indir / yükle** kullanılır.

## Veri kaynağı

Tarayıcı Yahoo / stockanalysis.com'a doğrudan erişemediği (CORS) için arada küçük bir Supabase Edge Function var:
[supabase/functions/temettu/index.ts](supabase/functions/temettu/index.ts)

- Arama: Yahoo Finance
- Temettü geçmişi + gerçek ödeme tarihleri: stockanalysis.com (ABD hisse/ETF ve BIST); bulunamazsa Yahoo
- USD/TRY kuru: Yahoo

## Kurulum

1. **Fonksiyon:** Supabase → Edge Functions → *Deploy a new function* → adı `temettu` → `index.ts` içeriğini yapıştır
   → ayarlarda **Verify JWT** kapalı. (CLI ile: `npx supabase functions deploy temettu --no-verify-jwt --project-ref jqmfvinbzgqyitqquzdc`)
2. **Site:** GitHub'da yeni depo (ör. `temettu`) → `index.html`, `app.js`, `style.css` dosyalarını yükle
   → Settings → Pages → *Deploy from a branch* → `main` / `(root)`.
3. Adres `https://valaiso.github.io/temettu/` olur. Fonksiyon yalnızca `valaiso.github.io` ve localhost'tan gelen istekleri kabul eder.

## Yerelde çalıştırma

```bash
node dev.mjs
```

http://localhost:8787 — aynı fonksiyon kodunu Node üzerinde çalıştırır (Node 23.6+).
