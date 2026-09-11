# دانلودر مکتب‌خونه (Maktabkhooneh Downloader)

ابزار خط فرمان برای دانلود محتوای قابل‌دسترسی دوره‌های [maktabkhooneh.org](https://maktabkhooneh.org) شامل ویدیو،
زیرنویس و فایل‌های ضمیمه.

فقط محتوایی را دانلود کنید که طبق قوانین به آن دسترسی دارید.

## نصب سریع

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/ErfanDavoodiNasr/maktabkhooneh-downloader/main/install.sh | bash
```

### Windows PowerShell

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/ErfanDavoodiNasr/maktabkhooneh-downloader/main/install.ps1 | iex"
```

## شروع سریع

اگر تازه‌کار هستید، همین مسیر کافی است: یک دستور نصب، پر کردن ایمیل/پسورد در `config.json`، بعد `--dry-run`. اسلاگ کوتاه
مثل `python` معمولاً کار نمی‌کند؛ اسلاگ کامل با `-mk<id>` لازم است.

1. فایل `config.json` را باز کنید و مقدارهای `auth.email` و `auth.password` را وارد کنید.
2. اسلاگ کامل دوره را پیدا کنید (معمولاً با پسوند `-mk<id>`).
3. برای دیدن پیش‌نمایش محتوا و حجم تقریبی:

```bash
node download.mjs "آموزش-گیت-جادی-mk12029" --dry-run
```

4. برای شروع دانلود:

```bash
node download.mjs "آموزش-گیت-جادی-mk12029"
```

این نصب سریع:

- نسخه مناسب Node.js را بررسی/نصب می‌کنند (در صورت امکان خودکار)
- `config.json` را می‌سازند (اگر وجود نداشته باشد)
- ایمیل و پسورد را تعاملی می‌پرسند (اختیاری)
- دستورات بعدی اجرا را نمایش می‌دهند

## پیش‌نیازها

- Node.js نسخه 20 یا بالاتر (LTS پشتیبانی‌شده)
- حساب کاربری مکتب‌خونه

## شیوه استفاده

1. اطلاعات ورود را در `config.json` تنظیم کنید.
2. اسلاگ کامل دوره را در CLI بدهید (مثال: `آموزش-گیت-جادی-mk12029`).
3. اگر می‌خواهید قبل از دانلود برآورد حجم داشته باشید، از `--dry-run` استفاده کنید.
4. اگر نشست منقضی شد، اجرا را با `--force-login` تکرار کنید.

### پشتیبانی از فرمت جدید LMS

ابزار هم ساختار قدیمی دوره و هم ساختار جدید LMS را پشتیبانی می‌کند:

- فرمت کلاسیک: `https://maktabkhooneh.org/course/<slug>-mk<id>/`
- فرمت LMS: `https://maktabkhooneh.org/lms/course/<slug>-mk<id>/unit/<unit_id>/`

اسلاگ باید کامل باشد و معمولاً به `-mk<id>` ختم شود (مثال: `آموزش-گیت-جادی-mk12029`). اسلاگ کوتاه مثل `python` معمولاً
404 می‌دهد.

اگر اسلاگ دوره پسوند `-mk<id>` داشته باشد، outline و ویدیو از APIهای `/api/v1/lms/...` خوانده می‌شوند. دادن آدرس یک unit
خاص هم کل دوره را دانلود می‌کند (نه فقط همان unit).

## تنظیمات (`config.json`)

فایل پیش‌فرض برنامه `config.json` است. اگر لازم باشد می‌توانید مسیر کانفیگ را عوض کنید:

```bash
node download.mjs "آموزش-گیت-جادی-mk12029" --config ./my-config.json
```

### نمونه ساختار کانفیگ

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

### معنی بخش‌ها

- `course.baseUrl`: آدرس پایه دوره‌ها
- `auth.email` و `auth.password`: ورود با حساب کاربری (پیشنهادی)
- `auth.cookie` یا `auth.cookieFile`: ورود با کوکی دستی
- `auth.sessionCookie`: نشست ذخیره‌شده خودکار پس از ورود موفق
- `runtime.*`: تنظیمات دانلود، timeout و retry
- `defaults.*`: پیش‌فرض فلگ‌های CLI

## ورود و نشست

دو روش ورود:

1. ایمیل/رمز (`auth.email`, `auth.password`) - روش پیشنهادی
2. کوکی دستی (`auth.cookie` یا `auth.cookieFile`)

پس از ورود موفق، نشست در `auth.sessionCookie` ذخیره می‌شود تا اجرای بعدی سریع‌تر باشد.

```bash
node download.mjs "آموزش-گیت-جادی-mk12029" --force-login
```

## دستورات رایج

```bash
# دانلود با اسلاگ کامل (-mk<id>)
node download.mjs "آموزش-گیت-جادی-mk12029"

# دانلود با URL کامل (اختیاری)
node download.mjs "https://maktabkhooneh.org/course/<slug>-mk<id>/"

# دانلود با آدرس LMS (فرمت جدید)
node download.mjs "https://maktabkhooneh.org/lms/course/<slug>-mk<id>/unit/<unit_id>/"

# پیش‌نمایش قبل از دانلود
node download.mjs "آموزش-گیت-جادی-mk12029" --dry-run

# دانلود انتخابی فصل/قسمت
node download.mjs "آموزش-گیت-جادی-mk12029" --chapter 2 --lesson 2-5,9

# دانلود نمونه‌ای برای تست سریع (حجم کم)
node download.mjs "آموزش-گیت-جادی-mk12029" --chapter 1 --lesson 1 --sample-bytes 65536 --verbose
```

## Dry Run چه خروجی می‌دهد؟

در حالت `--dry-run`:

- هیچ فایل واقعی دانلود نمی‌شود.
- پوشه خروجی ساخته نمی‌شود.
- برای هر قسمت، برآورد حجم و مسیر خروجی نمایش داده می‌شود.
- برای هر فصل و کل دوره، جمع‌بندی حجم تقریبی نمایش داده می‌شود.

نکته: اعداد بر اساس اطلاعات `HEAD/Range` سرور هستند و ممکن است با حجم نهایی کمی اختلاف داشته باشند.

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

نمونه تغییر در کانفیگ:

```json
{
  "runtime": {
    "retryAttempts": 5,
    "requestTimeoutMs": 45000,
    "readTimeoutMs": 180000
  }
}
```

## مسیر خروجی

فایل‌ها در مسیر زیر ذخیره می‌شوند:

```text
download/<نام دوره>
```

## خطاهای رایج

- `401 Unauthorized`: نشست نامعتبر یا منقضی شده است.
    - راه‌حل: اجرا با `--force-login`
- `403 Forbidden`: حساب فعلی دسترسی کافی ندارد.
    - راه‌حل: با حسابی که دسترسی دارد وارد شوید
- `Invalid course URL`: لینک دوره نامعتبر است.
    - راه‌حل: از فرمت `https://maktabkhooneh.org/course/<slug>/` یا
      `https://maktabkhooneh.org/lms/course/<slug>/unit/<unit_id>/` استفاده کنید
- `COURSE_INPUT`: اسلاگ یا URL دوره وارد نشده است.
    - راه‌حل: اسلاگ را در CLI بدهید (مثال: `node download.mjs "آموزش-گیت-جادی-mk12029"`)
- `CONFIG_MISSING`: مسیر `--config` پیدا نشد.
    - راه‌حل: فایل را بسازید یا `--config` را حذف کنید تا از `config.json` پیش‌فرض استفاده شود
- `FILTER_EMPTY`: هیچ درسی با فیلتر `--chapter`/`--lesson` جور نشد.
    - راه‌حل: شماره فصل/درس را چک کنید (شماره درس فقط ویدیوها را می‌شمارد) یا فیلتر را حذف کنید

## نکات امنیتی

- `config.json` ممکن است شامل رمز عبور یا کوکی نشست باشد؛ آن را عمومی منتشر نکنید.
- از `config.example.json` به عنوان قالب بدون رمز استفاده کنید.
- پسورد را در تاریخچه شل paste نکنید؛ ترجیحاً فایل کانفیگ را ویرایش کنید.
- کوکی‌های احراز هویت فقط به دامنه `maktabkhooneh.org` ارسال می‌شوند، نه به CDNهای رسانه.

## نویسنده

- [NabiKAZ](https://github.com/NabiKAZ) — پروژه اصلی
- [ErfanDavoodiNasr](https://github.com/ErfanDavoodiNasr) — بهبودها و نگهداری این فورک
- X: [x.com/NabiKAZ](https://x.com/NabiKAZ)
- Telegram: [t.me/BotSorati](https://t.me/BotSorati)

## لایسنس

GPL-3.0 - متن کامل در [LICENSE](./LICENSE)
