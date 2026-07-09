# landing-deployer

Serviço HTTP para deploy de landing pages a partir de ficheiros ZIP.

## Endpoints

### `GET /health`

Verifica se o serviço está a correr.

#### Resposta

- **200 OK**

```json
{
  "ok": true,
  "service": "landing-deployer",
  "version": "1.0.0"
}
```

---

### `POST /deploy`

Faz o deploy de uma landing page enviada como ficheiro ZIP no corpo do pedido.

#### Cabeçalhos (Headers)

| Header               | Obrigatório | Padrão     | Descrição                                                                 |
|----------------------|-------------|------------|---------------------------------------------------------------------------|
| `x-deploy-token`     | Sim         | —          | Token de autenticação. Deve coincidir com o segredo `LANDING_DEPLOY_TOKEN`. |
| `x-deploy-site`      | Sim         | —          | Nome do site a publicar (ex.: `laminas`). Deve ser alfanumérico com hífens (3–64 caracteres). |
| `x-deploy-env`       | Sim         | —          | Ambiente de deploy. Valores aceites: `production` ou `testing`.            |
| `x-deploy-filename`  | Não         | `site.zip` | Nome do ficheiro ZIP enviado. Apenas letras, números, `.`, `-` e `_`.     |

#### Corpo (Body)

- **Formato**: binário (raw bytes do ficheiro ZIP)
- **Tamanho máximo**: 200 MB

#### Conteúdo esperado do ZIP

O ZIP deve conter na raiz um ficheiro `version.json` com a seguinte estrutura:

```json
{
  "site": "laminas",
  "version": "1.0.0"
}
```

| Campo     | Tipo   | Descrição                                                  |
|-----------|--------|------------------------------------------------------------|
| `site`    | string | Deve coincidir com o valor do header `x-deploy-site`.       |
| `version` | string | Versão do deploy. Se for inferior à versão já publicada, o deploy é rejeitado. |

Além do `version.json`, o ZIP deve incluir uma das seguintes opções:

1. **Site estático**: um ficheiro `index.html` na raiz do ZIP.
2. **Projeto Node.js**: um ficheiro `package.json` na raiz do ZIP. Neste caso, o serviço executa `npm ci` (ou `npm install`) seguido de `npm run build`, e procura a saída em `dist/`, `build/` ou `out/` (a primeira que contiver `index.html`).

#### Respostas

- **200 OK** — Deploy realizado com sucesso.

```json
{
  "success": true,
  "site": "laminas",
  "env": "production",
  "domain": "laminas.lp.fhad.xyz",
  "zip": "site.zip",
  "version": "1.0.0",
  "release": "20260709-120000",
  "url": "https://laminas.lp.fhad.xyz"
}
```

| Campo      | Tipo    | Descrição                                      |
|------------|---------|------------------------------------------------|
| `success`  | boolean | Sempre `true` em caso de sucesso.              |
| `site`     | string  | Nome do site.                                  |
| `env`      | string  | Ambiente do deploy (`production` ou `testing`). |
| `domain`   | string  | Domínio atribuído ao site.                     |
| `zip`      | string  | Nome do ficheiro ZIP enviado.                  |
| `version`  | string  | Versão extraída do `version.json`.             |
| `release`  | string  | Timestamp da release (formato `YYYYMMDD-HHmmss`). |
| `url`      | string  | URL pública do site publicado.                 |

- **400 Bad Request** — Erro de validação ou falha no deploy.

```json
{
  "success": false,
  "error": "Descrição do erro."
}
```

Exemplos de erros:
- `Header x-deploy-site é obrigatório.`
- `Header x-deploy-env é obrigatório. Valores aceites: "production" ou "testing".`
- `Header x-deploy-env inválido. Valores aceites: "production" ou "testing".`
- `Nome de site inválido.`
- `Site "X" não está configurado no sites.json.`
- `Nome de ZIP inválido.`
- `version.json não encontrado na raiz do ZIP.`
- `Versão "X" é inferior à versão atual "Y".`
- `ZIP contém caminhos inseguros.`
- `Site não permitido: <nome>`
- `Build terminou, mas não encontrei dist/, build/ ou out/ com index.html.`

- **401 Unauthorized** — Token de autenticação inválido ou em falta.

```json
{
  "error": "Unauthorized"
}
```

- **404 Not Found** — Rota não reconhecida (qualquer método/URL diferente dos acima).

```json
{
  "error": "Not found"
}
```

---

### `POST /backup`

Cria um backup completo da pasta do site (incluindo todas as releases e configurações).
Os backups são guardados em `/data/backups` e expiram automaticamente após 5 dias.

#### Cabeçalhos (Headers)

| Header           | Obrigatório | Descrição                                                                 |
|------------------|-------------|---------------------------------------------------------------------------|
| `x-deploy-token` | Sim         | Token de autenticação. Deve coincidir com o segredo `LANDING_DEPLOY_TOKEN`. |
| `x-deploy-site`  | Sim         | Nome do site a fazer backup (ex.: `laminas`).                              |
| `x-deploy-env`   | Sim         | Ambiente do site. Valores aceites: `production` ou `testing`.              |

#### Respostas

- **200 OK** — Backup criado com sucesso.

```json
{
  "success": true,
  "site": "laminas",
  "env": "production",
  "backup": "laminas-production-20260709-120000.tar.gz",
  "path": "/data/backups/laminas-production-20260709-120000.tar.gz"
}
```

| Campo     | Tipo    | Descrição                                                   |
|-----------|---------|-------------------------------------------------------------|
| `success` | boolean | Sempre `true` em caso de sucesso.                           |
| `site`    | string  | Nome do site.                                               |
| `env`     | string  | Ambiente do backup (`production` ou `testing`).              |
| `backup`  | string  | Nome único do ficheiro de backup (usar no restore).         |
| `path`    | string  | Caminho absoluto do ficheiro de backup no servidor.         |

- **400 Bad Request** — Erro de validação ou site não encontrado.

```json
{
  "success": false,
  "error": "Site \"laminas\" (production) não encontrado. Nenhum deploy feito ainda."
}
```

- **401 Unauthorized** — Token inválido.

```json
{
  "error": "Unauthorized"
}
```

---

### `POST /restore`

Restaura um site a partir de um backup criado anteriormente.
**Atenção**: o site atual é completamente substituído pelo conteúdo do backup.

#### Cabeçalhos (Headers)

| Header            | Obrigatório | Descrição                                                                 |
|-------------------|-------------|---------------------------------------------------------------------------|
| `x-deploy-token`  | Sim         | Token de autenticação. Deve coincidir com o segredo `LANDING_DEPLOY_TOKEN`. |
| `x-deploy-site`   | Sim         | Nome do site a restaurar (ex.: `laminas`).                                 |
| `x-deploy-env`    | Sim         | Ambiente a restaurar. Valores aceites: `production` ou `testing`.          |
| `x-deploy-backup` | Sim         | Nome do ficheiro de backup (ex.: `laminas-production-20260709-120000.tar.gz`). |

#### Respostas

- **200 OK** — Restauro concluído com sucesso.

```json
{
  "success": true,
  "site": "laminas",
  "env": "production",
  "backup": "laminas-production-20260709-120000.tar.gz",
  "restored": true
}
```

| Campo      | Tipo    | Descrição                                     |
|------------|---------|-----------------------------------------------|
| `success`  | boolean | Sempre `true` em caso de sucesso.             |
| `site`     | string  | Nome do site.                                 |
| `env`      | string  | Ambiente restaurado (`production` ou `testing`). |
| `backup`   | string  | Nome do backup utilizado no restauro.         |
| `restored` | boolean | Sempre `true` em caso de sucesso.             |

- **400 Bad Request** — Erro de validação ou backup não encontrado.

```json
{
  "success": false,
  "error": "Backup não encontrado: demo-20260709-120000.tar.gz"
}
```

- **401 Unauthorized** — Token inválido.

```json
{
  "error": "Unauthorized"
}
```

---

### `POST /reset`

Remove completamente um site e todos os seus backups.
**Atenção**: esta operação é irreversível. Todos os deploys e backups do site são eliminados.

#### Cabeçalhos (Headers)

| Header           | Obrigatório | Descrição                                                                 |
|------------------|-------------|---------------------------------------------------------------------------|
| `x-deploy-token` | Sim         | Token de autenticação. Deve coincidir com o segredo `LANDING_DEPLOY_TOKEN`. |
| `x-deploy-site`  | Sim         | Nome do site a resetar (ex.: `laminas`).                                   |
| `x-deploy-env`   | Sim         | Ambiente a resetar. Valores aceites: `production` ou `testing`.            |

#### Respostas

- **200 OK** — Reset concluído com sucesso.

```json
{
  "success": true,
  "site": "laminas",
  "env": "testing",
  "siteRemoved": true,
  "backupsRemoved": 3
}
```

| Campo            | Tipo    | Descrição                                              |
|------------------|---------|--------------------------------------------------------|
| `success`        | boolean | Sempre `true` em caso de sucesso.                      |
| `site`           | string  | Nome do site.                                          |
| `env`            | string  | Ambiente (`production` ou `testing`).                  |
| `siteRemoved`    | boolean | `true` se o diretório do site foi removido.            |
| `backupsRemoved` | number  | Número de ficheiros de backup eliminados.              |

- **400 Bad Request** — Erro de validação ou site não encontrado.

```json
{
  "success": false,
  "error": "Site \"laminas\" não encontrado. Nenhum deploy ou backup para remover."
}
```

- **401 Unauthorized** — Token inválido.

```json
{
  "error": "Unauthorized"
}
```

## Variáveis de Ambiente

| Variável              | Padrão            | Descrição                                                                 |
|-----------------------|-------------------|---------------------------------------------------------------------------|
| `PORT`                | `8080`            | Porta onde o servidor HTTP escuta.                                        |
| `UPLOADS_DIR`         | `/data/uploads`   | Diretório onde os ZIPs enviados são guardados temporariamente.            |
| `SITES_DIR`           | `/data/sites`     | Diretório raiz onde os sites são publicados.                              |
| `TMP_DIR`             | `/data/tmp`       | Diretório temporário para extração e build.                               |
| `ALLOWED_SITES`       | (vazio)           | Lista adicional de sites permitidos, separados por vírgula. Se definida, o site também tem de estar nesta lista (além de estar configurado no `sites.json`). Se vazio, todos os sites do `sites.json` são permitidos. |
| `BACKUPS_DIR`         | `/data/backups`   | Diretório onde os backups são guardados.                                           |
| `LANDING_DEPLOY_TOKEN`| (obrigatório)     | Token de autenticação para os endpoints. Pode ser definido via environment ou Docker secret (`/run/secrets/LANDING_DEPLOY_TOKEN`). |

## Sites e domínios

Os sites válidos e respetivos domínios de produção e testing são definidos no ficheiro [`sites.json`](./sites.json) na raiz do projeto.

Cada entrada tem o seguinte formato:

```json
{
  "name": "laminas",
  "production": {
    "host": "lp.harmonizadoraelite.com.br"
  },
  "testing": {
    "host": "test.lp.harmonizadoraelite.com.br"
  }
}
```

| Campo              | Descrição                                    |
|--------------------|----------------------------------------------|
| `name`             | Nome do site (usado no header `x-deploy-site`). |
| `production.host`  | Domínio de produção do site.                  |
| `testing.host`     | Domínio de testing do site.                   |

Para sites não listados no `sites.json`, o domínio segue o padrão `<site>.lp.fhad.xyz`.

## Exemplo de utilização

```bash
# Health check
curl http://localhost:8080/health

# Deploy de um site estático (produção)
curl -X POST http://localhost:8080/deploy \
  -H "x-deploy-token: meu-token-secreto" \
  -H "x-deploy-site: laminas" \
  -H "x-deploy-env: production" \
  -H "x-deploy-filename: site.zip" \
  --data-binary @site.zip

# Deploy de um site estático (testing)
curl -X POST http://localhost:8080/deploy \
  -H "x-deploy-token: meu-token-secreto" \
  -H "x-deploy-site: laminas" \
  -H "x-deploy-env: testing" \
  -H "x-deploy-filename: site.zip" \
  --data-binary @site.zip

# Criar backup de um site
curl -X POST http://localhost:8080/backup \
  -H "x-deploy-token: meu-token-secreto" \
  -H "x-deploy-site: laminas" \
  -H "x-deploy-env: production"

# Restaurar um site a partir de um backup
curl -X POST http://localhost:8080/restore \
  -H "x-deploy-token: meu-token-secreto" \
  -H "x-deploy-site: laminas" \
  -H "x-deploy-env: production" \
  -H "x-deploy-backup: laminas-production-20260709-120000.tar.gz"

# Fazer reset completo de um site (remove deploys e backups)
curl -X POST http://localhost:8080/reset \
  -H "x-deploy-token: meu-token-secreto" \
  -H "x-deploy-site: laminas" \
  -H "x-deploy-env: testing"
```

## Testar com Bruno HTTP Client

O projeto inclui uma coleção de pedidos pronta a importar no [Bruno](https://www.usebruno.com/).

### Importar a coleção

1. Abre o Bruno
2. Clica em **Import Collection**
3. Escolhe a opção **Bruno Collection** e seleciona a pasta `bruno/` do projeto

### Configurar o ambiente

1. No Bruno, seleciona o environment **local** no canto superior direito
2. Clica em **Configure** e define:
   - `baseUrl` — URL do serviço (padrão: `http://localhost:8080`)
   - `deployToken` — token de autenticação (campo secreto)

### Pedidos disponíveis

| Pedido    | Método | Endpoint   | Descrição                    |
|-----------|--------|------------|------------------------------|
| health    | GET    | `/health`  | Verificar se o serviço está ativo |
| deploy    | POST   | `/deploy`  | Fazer deploy de um site (requer body binário com o ZIP) |
| backup    | POST   | `/backup`  | Criar backup de um site      |
| restore   | POST   | `/restore` | Restaurar um site a partir de um backup |

> **Nota**: Para o pedido `deploy`, seleciona o separador **Body** no Bruno, escolhe **Binary File** e carrega o ficheiro ZIP.
```
