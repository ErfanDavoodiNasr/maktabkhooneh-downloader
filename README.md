<div dir="rtl" align="right">

# دانلودر مکتب‌خونه (Maktabkhooneh Downloader)
ابزار خط فرمان برای دانلود محتوای قابل‌دسترسی دوره‌های [maktabkhooneh.org](https://maktabkhooneh.org) شامل ویدیو، زیرنویس و فایل‌های ضمیمه.

فقط محتوایی را دانلود کنید که طبق قوانین به آن دسترسی دارید.

## شروع سریع
فقط کافی است `config.json` را با اطلاعات ورود خود کامل کنید و اسلاگ دوره را در دستور اجرا بدهید.

<div dir="ltr">

```bash
# 1) در فایل config.json مقدارهای auth.email و auth.password را وارد کنید

# 2) پیش‌نمایش محتوا و حجم تقریبی
node download.mjs /python --dry-run

# 3) شروع دانلود
node download.mjs /python
```

</div>

## پیش‌نیازها
- Node.js نسخه 18 یا بالاتر
- حساب کاربری مکتب‌خونه

## روند استفاده
1. اطلاعات ورود را در `config.json` وارد کنید.
2. اسلاگ دوره را در CLI بدهید (مثلا `/python`).
3. در صورت نیاز ابتدا با `--dry-run` پیش‌نمایش بگیرید.
4. برای دانلود واقعی، دستور را بدون `--dry-run` اجرا کنید.
5. اگر نشست منقضی شد، از `--force-login` استفاده کنید.

## تنظیمات (`config.json`)
فایل پیش‌فرض برنامه `config.json` است. اگر لازم باشد می‌توانید مسیر فایل کانفیگ را با `--config` تغییر دهید.

<div dir="ltr">

```bash
node download.mjs /python --config ./my-config.json
```

</div>

### ساختار کامل کانفیگ
<div dir="ltr">

```json
{
  "course": {
    "baseUrl": "https://maktabkhooneh.org/course/"
  },
  "auth": {
    "email": "you@example.com",
    "password": "Secret123",
    "cookie": "",
    "cookieFile": "",
    "sessionCookie": "",
    "sessionUpdated": ""
  },
  "runtime": {
    "sampleBytes": 0,
    "retryAttempts": 4,
    "requestTimeoutMs": 30000,
    "readTimeoutMs": 120000
  },
  "defaults": {
    "chapter": "",
    "lesson": "",
    "dryRun": false,
    "forceLogin": false,
    "verbose": false
  }
}
```

</div>

### معنی بخش‌ها
- `course.baseUrl`: آدرس پایهٔ دوره‌ها.
- `auth.email` و `auth.password`: ورود با حساب کاربری (پیشنهادی).
- `auth.cookie` یا `auth.cookieFile`: ورود با کوکی دستی.
- `auth.sessionCookie`: نشست ذخیره‌شدهٔ خودکار بعد از ورود موفق.
- `runtime.*`: تنظیمات شبکه و نمونه‌گیری دانلود.
- `defaults.*`: پیش‌فرض فلگ‌های CLI.

## ورود و نشست
دو روش ورود دارید:
1. ایمیل/رمز (`auth.email`, `auth.password`) - پیشنهاد اصلی
2. کوکی دستی (`auth.cookie` یا `auth.cookieFile`)

بعد از ورود موفق، نشست در `auth.sessionCookie` ذخیره می‌شود تا اجرای بعدی سریع‌تر انجام شود.

<div dir="ltr">

```bash
# ورود مجدد اجباری در صورت نیاز
node download.mjs /python --force-login
```

</div>

## دستورات رایج
<div dir="ltr">

```bash
# دانلود با اسلاگ
node download.mjs /python

# دانلود با URL کامل (اختیاری)
node download.mjs "https://maktabkhooneh.org/course/<slug>/"

# پیش‌نمایش (بدون ذخیره فایل)
node download.mjs /python --dry-run

# دانلود انتخابی فصل/قسمت
node download.mjs /python --chapter 2 --lesson 2-5,9

# دانلود نمونه‌ای (برای تست سریع)
node download.mjs /python --sample-bytes 65536 --verbose
```

</div>

## Dry Run چه نشان می‌دهد؟
در حالت `--dry-run`:
- فایل واقعی دانلود نمی‌شود.
- پوشهٔ خروجی ساخته نمی‌شود.
- برای هر قسمت، برآورد حجم و مسیر خروجی نمایش داده می‌شود.
- برای هر فصل و کل دوره، جمع‌بندی حجم تقریبی نمایش داده می‌شود.

نکته: اعداد بر اساس اطلاعات `HEAD/Range` سرور محاسبه می‌شوند و ممکن است با حجم نهایی کمی اختلاف داشته باشند.

## فرمت معتبر `--chapter` و `--lesson`
- عدد تکی: `2`
- لیست: `1,3,7`
- بازه: `2-5`
- ترکیبی: `2-5,9`

## Retry و Timeout
مقادیر پیش‌فرض:
- `retryAttempts`: `4`
- `requestTimeoutMs`: `30000`
- `readTimeoutMs`: `120000`

<div dir="ltr">

```json
{
  "runtime": {
    "retryAttempts": 5,
    "requestTimeoutMs": 45000,
    "readTimeoutMs": 180000
  }
}
```

</div>

## خروجی دانلود
مسیر خروجی به این شکل است:
<div dir="ltr">

```text
download/<نام دوره>
```

</div>

## خطاهای رایج
- `401 Unauthorized`: نشست نامعتبر یا منقضی شده است.
  راه‌حل: اجرای مجدد با `--force-login`.
- `403 Forbidden`: حساب فعلی دسترسی لازم به دوره را ندارد.
  راه‌حل: با حسابی که دسترسی دارد وارد شوید.
- `Invalid course URL`: لینک دوره نامعتبر است.
  راه‌حل: از فرمت `https://maktabkhooneh.org/course/<slug>/` استفاده کنید.
- `COURSE_INPUT`: اسلاگ یا URL دوره وارد نشده است.
  راه‌حل: اسلاگ را در CLI بدهید. مثال: `node download.mjs /python`

## نکات امنیتی
- `config.json` ممکن است شامل رمز عبور یا کوکی نشست باشد؛ آن را عمومی منتشر نکنید.

## نویسنده
- [NabiKAZ](https://github.com/NabiKAZ)
- X: [x.com/NabiKAZ](https://x.com/NabiKAZ)
- Telegram: [t.me/BotSorati](https://t.me/BotSorati)

## لایسنس
GPL-3.0 - متن کامل در [LICENSE](./LICENSE)

</div>
