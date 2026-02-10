# دانلودر مکتب‌خونه (Maktabkhooneh Downloader)
ابزار خط فرمان برای دانلود محتوای قابل‌دسترسی دوره‌های [maktabkhooneh.org](https://maktabkhooneh.org) شامل ویدیو، زیرنویس و فایل‌های ضمیمه.

فقط محتوایی را دانلود کنید که طبق قوانین به آن دسترسی دارید.

## شروع سریع
1. فایل `config.json` را باز کنید و مقدارهای `auth.email` و `auth.password` را وارد کنید.
2. برای دیدن پیش‌نمایش محتوا و حجم تقریبی:
```bash
node download.mjs /python --dry-run
```
3. برای شروع دانلود:
```bash
node download.mjs /python
```

## پیش‌نیازها
- Node.js نسخه 18 یا بالاتر
- حساب کاربری مکتب‌خونه

## شیوه استفاده
1. اطلاعات ورود را در `config.json` تنظیم کنید.
2. اسلاگ دوره را در CLI بدهید (مثال: `/python`).
3. اگر می‌خواهید قبل از دانلود برآورد حجم داشته باشید، از `--dry-run` استفاده کنید.
4. اگر نشست منقضی شد، اجرا را با `--force-login` تکرار کنید.

## تنظیمات (`config.json`)
فایل پیش‌فرض برنامه `config.json` است. اگر لازم باشد می‌توانید مسیر کانفیگ را عوض کنید:

```bash
node download.mjs /python --config ./my-config.json
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
node download.mjs /python --force-login
```

## دستورات رایج
```bash
# دانلود با اسلاگ
node download.mjs /python

# دانلود با URL کامل (اختیاری)
node download.mjs "https://maktabkhooneh.org/course/<slug>/"

# پیش‌نمایش قبل از دانلود
node download.mjs /python --dry-run

# دانلود انتخابی فصل/قسمت
node download.mjs /python --chapter 2 --lesson 2-5,9

# دانلود نمونه‌ای برای تست سریع
node download.mjs /python --sample-bytes 65536 --verbose
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
  - راه‌حل: از فرمت `https://maktabkhooneh.org/course/<slug>/` استفاده کنید
- `COURSE_INPUT`: اسلاگ یا URL دوره وارد نشده است.
  - راه‌حل: اسلاگ را در CLI بدهید (مثال: `node download.mjs /python`)

## نکات امنیتی
- `config.json` ممکن است شامل رمز عبور یا کوکی نشست باشد؛ آن را عمومی منتشر نکنید.

## نویسنده
- [NabiKAZ](https://github.com/NabiKAZ)
- X: [x.com/NabiKAZ](https://x.com/NabiKAZ)
- Telegram: [t.me/BotSorati](https://t.me/BotSorati)

## لایسنس
GPL-3.0 - متن کامل در [LICENSE](./LICENSE)
