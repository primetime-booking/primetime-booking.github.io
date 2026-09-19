# PrimeTime client

Клиентский сайт онлайн-записи PrimeTime: <https://primetime-booking.github.io/>.

Кабинет исполнителя PrimeTime Pro и тренажёр «Анатомия массажиста» в этот репозиторий не входят. Сайт использует только публичный Supabase publishable key; серверные секреты здесь не хранятся.

## Проверка

```powershell
node tests/client-pages-static-test.mjs
node public-booking-flow-test.mjs
```
