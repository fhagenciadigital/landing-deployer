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
| `x-deploy-site`      | Sim         | —          | Nome do site a publicar (ex.: `demo`). Deve ser alfanumérico com hífens (3–64 caracteres). |
| `x-deploy-filename`  | Não         | `site.zip` | Nome do ficheiro ZIP enviado. Apenas letras, números, `.`, `-` e `_`.     |

#### Corpo (Body)

- **Formato**: binário (raw bytes do ficheiro ZIP)
- **Tamanho máximo**: 200 MB

#### Conteúdo esperado do ZIP

O ZIP deve conter na raiz um ficheiro `version.json` com a seguinte estrutura:

```json
{
  "site": "demo",
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
  "site": "demo",
  "domain": "demo.lp.fhad.xyz",
  "zip": "site.zip",
  "version": "1.0.0",
  "release": "20260709-120000",
  "url": "https://demo.lp.fhad.xyz"
}
```

| Campo      | Tipo    | Descrição                                      |
|------------|---------|------------------------------------------------|
| `success`  | boolean | Sempre `true` em caso de sucesso.              |
| `site`     | string  | Nome do site.                                  |
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
- `Nome de site inválido.`
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
| `x-deploy-site`  | Sim         | Nome do site a fazer backup (ex.: `demo`).                                 |

#### Respostas

- **200 OK** — Backup criado com sucesso.

```json
{
  "success": true,
  "site": "demo",
  "backup": "demo-20260709-120000.tar.gz",
  "path": "/data/backups/demo-20260709-120000.tar.gz"
}
```

| Campo     | Tipo    | Descrição                                                   |
|-----------|---------|-------------------------------------------------------------|
| `success` | boolean | Sempre `true` em caso de sucesso.                           |
| `site`    | string  | Nome do site.                                               |
| `backup`  | string  | Nome único do ficheiro de backup (usar no restore).         |
| `path`    | string  | Caminho absoluto do ficheiro de backup no servidor.         |

- **400 Bad Request** — Erro de validação ou site não encontrado.

```json
{
  "success": false,
  "error": "Site \"demo\" não encontrado. Nenhum deploy feito ainda."
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
| `x-deploy-site`   | Sim         | Nome do site a restaurar (ex.: `demo`).                                    |
| `x-deploy-backup` | Sim         | Nome do ficheiro de backup (ex.: `demo-20260709-120000.tar.gz`).           |

#### Respostas

- **200 OK** — Restauro concluído com sucesso.

```json
{
  "success": true,
  "site": "demo",
  "backup": "demo-20260709-120000.tar.gz",
  "restored": true
}
```

| Campo      | Tipo    | Descrição                                     |
|------------|---------|-----------------------------------------------|
| `success`  | boolean | Sempre `true` em caso de sucesso.             |
| `site`     | string  | Nome do site.                                 |
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

## Variáveis de Ambiente

| Variável              | Padrão            | Descrição                                                                 |
|-----------------------|-------------------|---------------------------------------------------------------------------|
| `PORT`                | `8080`            | Porta onde o servidor HTTP escuta.                                        |
| `UPLOADS_DIR`         | `/data/uploads`   | Diretório onde os ZIPs enviados são guardados temporariamente.            |
| `SITES_DIR`           | `/data/sites`     | Diretório raiz onde os sites são publicados.                              |
| `TMP_DIR`             | `/data/tmp`       | Diretório temporário para extração e build.                               |
| `ALLOWED_SITES`       | (vazio)           | Lista de sites permitidos, separados por vírgula. Se vazio, todos são permitidos. |
| `BACKUPS_DIR`         | `/data/backups`   | Diretório onde os backups são guardados.                                           |
| `LANDING_DEPLOY_TOKEN`| (obrigatório)     | Token de autenticação para os endpoints. Pode ser definido via environment ou Docker secret (`/run/secrets/LANDING_DEPLOY_TOKEN`). |

## Domínios pré-configurados

| Site       | Domínio                            |
|------------|------------------------------------|
| `demo`     | `demo.lp.fhad.xyz`                |
| `laminas`  | `lp.harmonizadoraelite.com.br`    |
| `adaa`     | `lp.adaa.com.pt`                  |

Para sites não listados, o domínio segue o padrão `<site>.lp.fhad.xyz`.

## Exemplo de utilização

```bash
# Health check
curl http://localhost:8080/health

# Deploy de um site estático
curl -X POST http://localhost:8080/deploy \
  -H "x-deploy-token: meu-token-secreto" \
  -H "x-deploy-site: demo" \
  -H "x-deploy-filename: site.zip" \
  --data-binary @site.zip

# Criar backup de um site
curl -X POST http://localhost:8080/backup \
  -H "x-deploy-token: meu-token-secreto" \
  -H "x-deploy-site: demo"

# Restaurar um site a partir de um backup
curl -X POST http://localhost:8080/restore \
  -H "x-deploy-token: meu-token-secreto" \
  -H "x-deploy-site: demo" \
  -H "x-deploy-backup: demo-20260709-120000.tar.gz"
```
