import express from 'express';

const router = express();
router.disable('x-powered-by');

router.get('/', (req, res)=>{
    res.status(200).json({ status: "OK"});
});

export default router;