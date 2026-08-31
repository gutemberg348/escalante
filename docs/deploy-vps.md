# Publicação na VPS (Nginx + PM2)

Este roteiro pressupõe Ubuntu/Debian, Node 20+ e Nginx/PM2 já instalados. O diretório de publicação será `/var/www/escala-cicc`.

## 1. DNS antes do certificado

No provedor onde o domínio foi comprado, crie um registro **A** para `SEU_DOMINIO` apontando para o IP público da VPS. Para usar `www`, crie outro A para `www` no mesmo IP. Só crie registro AAAA se a VPS tiver IPv6 configurado.

Confirme na VPS após a propagação:

```bash
dig +short SEU_DOMINIO
```

## 2. Baixar e preparar o projeto

```bash
sudo mkdir -p /var/www
sudo chown "$USER":"$USER" /var/www
git clone URL_DO_REPOSITORIO /var/www/escala-cicc
cd /var/www/escala-cicc
npm ci
npm run build
```

O arquivo `data/escala.sqlite` versionado é a escala inicial preenchida. Ele não deve ser apagado. As alterações feitas em produção ficam no banco local da VPS; faça backups antes de atualizar o projeto.

## 3. Criar o `.env` da VPS

```bash
cp .env.example .env
nano .env
```

Use estes valores (substitua domínio, e-mail e senha):

```dotenv
NODE_ENV=production
API_PORT=3000
WEB_URL=https://SEU_DOMINIO
DATABASE_PATH=./data/escala.sqlite
SESSION_SECRET=COLE_UM_SEGREDO_GRANDE
LOG_LEVEL=info
ADMIN_EMAIL=SEU_EMAIL
ADMIN_INITIAL_PASSWORD=UMA_SENHA_FORTE
```

Gere o segredo com `openssl rand -hex 32`. Não exponha esse arquivo e não o envie ao Git.

## 4. Subir a API com PM2

```bash
cd /var/www/escala-cicc
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup
```

Execute o comando que o último `pm2 startup` mostrar. Depois verifique:

```bash
pm2 status
curl http://127.0.0.1:3000/api/health
```

## 5. Nginx e HTTPS

Substitua o domínio no arquivo e ative o site:

```bash
cd /var/www/escala-cicc
sed 's/SEU_DOMINIO/DOMINIO_REAL/g' deploy/nginx-escala-cicc.conf | sudo tee /etc/nginx/sites-available/escala-cicc >/dev/null
sudo ln -s /etc/nginx/sites-available/escala-cicc /etc/nginx/sites-enabled/escala-cicc
sudo nginx -t
sudo systemctl reload nginx
```

Libere somente HTTP/HTTPS no firewall e mantenha a porta 3000 restrita ao servidor:

```bash
sudo ufw allow 'Nginx Full'
sudo ufw delete allow 3000/tcp
```

Emita o certificado:

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d DOMINIO_REAL -d www.DOMINIO_REAL
```

Se não for usar `www`, execute o Certbot somente com `-d DOMINIO_REAL` e retire `www.SEU_DOMINIO` da configuração Nginx antes de ativá-la.

## Atualizações futuras

Não execute `git reset` na VPS, pois o banco em produção muda. Antes de atualizar, faça uma cópia:

```bash
cd /var/www/escala-cicc
mkdir -p backups
cp data/escala.sqlite "backups/escala-$(date +%F-%H%M).sqlite"
git pull
npm ci
npm run build
pm2 restart escala-cicc-api
```

Após a primeira publicação, será necessário conectar novamente o WhatsApp pelo QR Code, porque a sessão não é enviada ao Git por segurança.
