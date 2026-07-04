import express from 'express'
import { computeSchedule } from './index'

const app = express()

app.get('/schedule', (req, res) => {
  res.json(computeSchedule(String(req.query.zone), Number(req.query.moisture)))
})

app.listen(8080)
